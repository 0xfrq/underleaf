//! Task tracker: Jira-style issues, sprints, comments and an activity log, attached to projects.
//!
//! Access follows project membership. Owners and editors manage issues and sprints; viewers can
//! read and comment, and may move issues that are assigned to them. Every change is broadcast to
//! the project's WebSocket room so open boards refresh live.

use axum::{
    extract::{Path, State},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension, Row, ToSql};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    projects::{members_of, role_of, Role},
    util::{is_valid_id, now},
    Shared,
};

pub const KINDS: &[&str] = &["task", "story", "bug", "epic"];
pub const STATUSES: &[&str] = &["todo", "in_progress", "review", "done"];
pub const PRIORITIES: &[&str] = &["highest", "high", "medium", "low", "lowest"];

/// Gap between neighbouring sort keys. New issues go to the bottom of the backlog.
const SORT_STEP: f64 = 1024.0;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Deserialize a field so that "absent" (None) and "null" (Some(None)) can be told apart.
fn nullable<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

fn check_pid(pid: &str) -> AppResult<()> {
    if is_valid_id(pid) {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}

fn require_edit(role: Role) -> AppResult<()> {
    if role.can_edit() {
        Ok(())
    } else {
        Err(AppError::forbidden(
            "you have read-only access to this project",
        ))
    }
}

/// A single line of text (summary, sprint name).
fn clean_line(s: &str, max: usize, what: &str) -> AppResult<String> {
    let s: String = s.trim().chars().filter(|c| !c.is_control()).collect();
    if s.is_empty() || s.chars().count() > max {
        return Err(AppError::bad(format!("{what} must be 1-{max} characters")));
    }
    Ok(s)
}

/// Multi-line text (description, comment, sprint goal).
fn clean_text(s: &str, max: usize, what: &str) -> AppResult<String> {
    let s: String = s
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    let s = s.trim().to_string();
    if s.chars().count() > max {
        return Err(AppError::bad(format!(
            "{what} can be at most {max} characters"
        )));
    }
    Ok(s)
}

fn one_of(v: &str, allowed: &[&str], what: &str) -> AppResult<String> {
    if allowed.contains(&v) {
        Ok(v.to_string())
    } else {
        Err(AppError::bad(format!("unknown {what} '{v}'")))
    }
}

/// A calendar date in the `YYYY-MM-DD` form used by `<input type=date>`.
fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10
        || !b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
    {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (
        s[0..4].parse::<u32>(),
        s[5..7].parse::<u32>(),
        s[8..10].parse::<u32>(),
    ) else {
        return false;
    };
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&m) {
        return false;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&d)
}

fn clean_date(d: Option<&str>) -> AppResult<Option<String>> {
    match d.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) if valid_date(s) => Ok(Some(s.to_string())),
        Some(_) => Err(AppError::bad("dates must be given as YYYY-MM-DD")),
    }
}

/// ISO dates compare correctly as strings.
fn check_range(start: &Option<String>, end: &Option<String>, what: &str) -> AppResult<()> {
    if let (Some(s), Some(e)) = (start, end) {
        if s > e {
            return Err(AppError::bad(format!(
                "the start date must not be after the {what}"
            )));
        }
    }
    Ok(())
}

fn check_estimate(e: Option<i64>) -> AppResult<Option<i64>> {
    match e {
        Some(v) if !(0..=999).contains(&v) => {
            Err(AppError::bad("story points must be between 0 and 999"))
        }
        v => Ok(v),
    }
}

/// Labels are stored comma-separated. Whitespace inside a label becomes '-', like in Jira.
fn clean_labels(v: &[String]) -> AppResult<String> {
    let mut out: Vec<String> = Vec::new();
    for l in v {
        let l: String = l
            .chars()
            .filter(|c| !c.is_control() && *c != ',')
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-");
        if l.is_empty() {
            continue;
        }
        if l.chars().count() > 32 {
            return Err(AppError::bad("labels can be at most 32 characters"));
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(&l)) {
            out.push(l);
        }
    }
    if out.len() > 10 {
        return Err(AppError::bad("an issue can have at most 10 labels"));
    }
    Ok(out.join(","))
}

fn split_labels(s: &str) -> Vec<String> {
    s.split(',')
        .filter(|x| !x.is_empty())
        .map(String::from)
        .collect()
}

fn clean_key(k: &str) -> AppResult<String> {
    let k = k.trim().to_ascii_uppercase();
    let ok = (2..=10).contains(&k.len())
        && k.as_bytes()[0].is_ascii_uppercase()
        && k.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    if ok {
        Ok(k)
    } else {
        Err(AppError::bad(
            "the key must be 2-10 letters or digits and start with a letter",
        ))
    }
}

/// Initials of the project name ("My Thesis" -> "MT"), or the start of a single word.
fn default_key(name: &str) -> String {
    let words: Vec<String> = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.chars().next().is_some_and(|c| c.is_ascii_alphabetic()))
        .map(|w| w.to_ascii_uppercase())
        .collect();
    let key: String = match words.as_slice() {
        [] => String::new(),
        [one] => one.chars().take(4).collect(),
        many => many
            .iter()
            .take(4)
            .filter_map(|w| w.chars().next())
            .collect(),
    };
    if key.len() >= 2 {
        key
    } else {
        "TASK".into()
    }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/// Create the project's board on first use and return its issue key.
fn ensure_board(c: &Connection, pid: &str) -> AppResult<String> {
    let key: Option<String> = c
        .query_row(
            "SELECT task_key FROM boards WHERE project_id = ?1",
            params![pid],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(k) = key {
        return Ok(k);
    }
    let name: String = c.query_row(
        "SELECT name FROM projects WHERE id = ?1",
        params![pid],
        |r| r.get(0),
    )?;
    let key = default_key(&name);
    c.execute(
        "INSERT INTO boards (project_id, task_key, next_num) VALUES (?1, ?2, 1)",
        params![pid, key],
    )?;
    Ok(key)
}

fn is_member(c: &Connection, pid: &str, uid: i64) -> AppResult<bool> {
    match role_of(c, pid, uid) {
        Ok(_) => Ok(true),
        Err(AppError::NotFound) => Ok(false),
        Err(e) => Err(e),
    }
}

fn check_sprint(c: &Connection, pid: &str, sid: i64) -> AppResult<()> {
    let state: Option<String> = c
        .query_row(
            "SELECT state FROM sprints WHERE id = ?1 AND project_id = ?2",
            params![sid, pid],
            |r| r.get(0),
        )
        .optional()?;
    match state.as_deref() {
        None => Err(AppError::bad("unknown sprint")),
        Some("closed") => Err(AppError::bad("that sprint is already completed")),
        Some(_) => Ok(()),
    }
}

fn check_parent(c: &Connection, pid: &str, parent: i64) -> AppResult<()> {
    let kind: Option<String> = c
        .query_row(
            "SELECT kind FROM tasks WHERE id = ?1 AND project_id = ?2",
            params![parent, pid],
            |r| r.get(0),
        )
        .optional()?;
    match kind.as_deref() {
        Some("epic") => Ok(()),
        Some(_) => Err(AppError::bad("the parent of an issue must be an epic")),
        None => Err(AppError::bad("unknown epic")),
    }
}

fn has_children(c: &Connection, tid: i64) -> AppResult<bool> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE parent_id = ?1)",
        params![tid],
        |r| r.get(0),
    )?)
}

fn task_exists(c: &Connection, pid: &str, tid: i64) -> AppResult<()> {
    let ok: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1 AND project_id = ?2)",
        params![tid, pid],
        |r| r.get(0),
    )?;
    if ok {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}

const TASK_SELECT: &str =
    "SELECT t.id, t.num, t.title, t.kind, t.status, t.priority, t.assignee_id,
        t.reporter_id, t.sprint_id, t.parent_id, t.start_date, t.due_date, t.estimate, t.labels,
        t.sort_key, t.created_at, t.updated_at, t.resolved_at, ua.display_name, ur.display_name,
        (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id), t.description != '',
        t.project_id
     FROM tasks t
     LEFT JOIN users ua ON ua.id = t.assignee_id
     LEFT JOIN users ur ON ur.id = t.reporter_id";

fn task_json(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "num": r.get::<_, i64>(1)?,
        "title": r.get::<_, String>(2)?,
        "kind": r.get::<_, String>(3)?,
        "status": r.get::<_, String>(4)?,
        "priority": r.get::<_, String>(5)?,
        "assignee_id": r.get::<_, Option<i64>>(6)?,
        "reporter_id": r.get::<_, Option<i64>>(7)?,
        "sprint_id": r.get::<_, Option<i64>>(8)?,
        "parent_id": r.get::<_, Option<i64>>(9)?,
        "start_date": r.get::<_, Option<String>>(10)?,
        "due_date": r.get::<_, Option<String>>(11)?,
        "estimate": r.get::<_, Option<i64>>(12)?,
        "labels": split_labels(&r.get::<_, String>(13)?),
        "sort_key": r.get::<_, f64>(14)?,
        "created_at": r.get::<_, i64>(15)?,
        "updated_at": r.get::<_, i64>(16)?,
        "resolved_at": r.get::<_, Option<i64>>(17)?,
        "assignee_name": r.get::<_, Option<String>>(18)?,
        "reporter_name": r.get::<_, Option<String>>(19)?,
        "comments": r.get::<_, i64>(20)?,
        "has_description": r.get::<_, bool>(21)?,
        "project_id": r.get::<_, String>(22)?,
    }))
}

/// `filter` is appended after WHERE and may carry ORDER BY / LIMIT.
fn query_tasks(c: &Connection, filter: &str, args: &[&dyn ToSql]) -> AppResult<Vec<Value>> {
    let mut st = c.prepare(&format!("{TASK_SELECT} WHERE {filter}"))?;
    let rows = st.query_map(args, task_json)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn one_task(c: &Connection, pid: &str, tid: i64) -> AppResult<Value> {
    query_tasks(c, "t.id = ?1 AND t.project_id = ?2", params![tid, pid])?
        .pop()
        .ok_or(AppError::NotFound)
}

const SPRINT_COLS: &str = "id, name, goal, state, start_date, end_date, created_at, completed_at";

fn sprint_json(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "name": r.get::<_, String>(1)?,
        "goal": r.get::<_, String>(2)?,
        "state": r.get::<_, String>(3)?,
        "start_date": r.get::<_, Option<String>>(4)?,
        "end_date": r.get::<_, Option<String>>(5)?,
        "created_at": r.get::<_, i64>(6)?,
        "completed_at": r.get::<_, Option<i64>>(7)?,
    }))
}

/// Active sprint first, then planned ones, then completed ones.
fn sprints_of(c: &Connection, pid: &str) -> AppResult<Vec<Value>> {
    let mut st = c.prepare(&format!(
        "SELECT {SPRINT_COLS} FROM sprints WHERE project_id = ?1
         ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, id"
    ))?;
    let rows = st.query_map(params![pid], sprint_json)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn one_sprint(c: &Connection, sid: i64) -> AppResult<Value> {
    Ok(c.query_row(
        &format!("SELECT {SPRINT_COLS} FROM sprints WHERE id = ?1"),
        params![sid],
        sprint_json,
    )?)
}

fn epics_of(c: &Connection, pid: &str) -> AppResult<Vec<Value>> {
    let mut st = c.prepare(
        "SELECT id, num, title, status FROM tasks
         WHERE project_id = ?1 AND kind = 'epic' ORDER BY sort_key, id",
    )?;
    let rows = st.query_map(params![pid], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "num": r.get::<_, i64>(1)?,
            "title": r.get::<_, String>(2)?,
            "status": r.get::<_, String>(3)?,
        }))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

const COMMENT_SELECT: &str =
    "SELECT c.id, c.user_id, u.display_name, c.body, c.created_at, c.edited_at
     FROM task_comments c JOIN users u ON u.id = c.user_id";

fn comment_json(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "user_id": r.get::<_, i64>(1)?,
        "name": r.get::<_, String>(2)?,
        "body": r.get::<_, String>(3)?,
        "created_at": r.get::<_, i64>(4)?,
        "edited_at": r.get::<_, Option<i64>>(5)?,
    }))
}

fn comments_of(c: &Connection, tid: i64) -> AppResult<Vec<Value>> {
    let mut st = c.prepare(&format!(
        "{COMMENT_SELECT} WHERE c.task_id = ?1 ORDER BY c.id"
    ))?;
    let rows = st.query_map(params![tid], comment_json)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn history_of(c: &Connection, tid: i64) -> AppResult<Vec<Value>> {
    let mut st = c.prepare(
        "SELECT a.id, a.user_id, u.display_name, a.field, a.old_value, a.new_value, a.created_at
         FROM task_activity a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.task_id = ?1 ORDER BY a.id DESC LIMIT 200",
    )?;
    let rows = st.query_map(params![tid], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "user_id": r.get::<_, Option<i64>>(1)?,
            "name": r.get::<_, Option<String>>(2)?,
            "field": r.get::<_, String>(3)?,
            "old": r.get::<_, Option<String>>(4)?,
            "new": r.get::<_, Option<String>>(5)?,
            "created_at": r.get::<_, i64>(6)?,
        }))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn log_activity(
    c: &Connection,
    tid: i64,
    uid: i64,
    field: &str,
    old: Option<&str>,
    new: Option<&str>,
    t: i64,
) -> AppResult<()> {
    c.execute(
        "INSERT INTO task_activity (task_id, user_id, field, old_value, new_value, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![tid, uid, field, old, new, t],
    )?;
    Ok(())
}

fn user_name(c: &Connection, id: Option<i64>) -> AppResult<Option<String>> {
    let Some(id) = id else { return Ok(None) };
    Ok(c.query_row(
        "SELECT display_name FROM users WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .optional()?)
}

fn sprint_name(c: &Connection, id: Option<i64>) -> AppResult<Option<String>> {
    let Some(id) = id else { return Ok(None) };
    Ok(
        c.query_row("SELECT name FROM sprints WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .optional()?,
    )
}

fn task_ref(c: &Connection, key: &str, id: Option<i64>) -> AppResult<Option<String>> {
    let Some(id) = id else { return Ok(None) };
    Ok(c.query_row(
        "SELECT num, title FROM tasks WHERE id = ?1",
        params![id],
        |r| {
            Ok(format!(
                "{key}-{} {}",
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?
            ))
        },
    )
    .optional()?)
}

fn bottom_key(c: &Connection, pid: &str) -> AppResult<f64> {
    let max: Option<f64> = c.query_row(
        "SELECT MAX(sort_key) FROM tasks WHERE project_id = ?1",
        params![pid],
        |r| r.get(0),
    )?;
    Ok(max.unwrap_or(0.0) + SORT_STEP)
}

/// Spread the sort keys of a project out again once two neighbours got too close.
fn renumber(c: &Connection, pid: &str) -> AppResult<()> {
    let ids: Vec<i64> = {
        let mut st =
            c.prepare("SELECT id FROM tasks WHERE project_id = ?1 ORDER BY sort_key, id")?;
        let rows = st.query_map(params![pid], |r| r.get(0))?;
        let v = rows.collect::<Result<Vec<i64>, _>>()?;
        v
    };
    let mut up = c.prepare("UPDATE tasks SET sort_key = ?1 WHERE id = ?2")?;
    for (i, id) in ids.iter().enumerate() {
        up.execute(params![(i as f64 + 1.0) * SORT_STEP, id])?;
    }
    Ok(())
}

/// Give `tid` a sort key between `prev` and `next`, its neighbours in the list it was dropped
/// into. Every list (board column, sprint, backlog) is a filtered view of one project-wide
/// order, so any key strictly between the two neighbours is correct.
fn place(
    c: &Connection,
    pid: &str,
    tid: i64,
    prev: Option<i64>,
    next: Option<i64>,
) -> AppResult<()> {
    let key_of = |id: Option<i64>| -> AppResult<Option<f64>> {
        match id {
            Some(id) if id != tid => Ok(c
                .query_row(
                    "SELECT sort_key FROM tasks WHERE id = ?1 AND project_id = ?2",
                    params![id, pid],
                    |r| r.get(0),
                )
                .optional()?),
            _ => Ok(None),
        }
    };
    let (mut lo, mut hi) = (key_of(prev)?, key_of(next)?);
    if let (Some(a), Some(b)) = (lo, hi) {
        if (b - a).abs() < 1e-6 {
            renumber(c, pid)?;
            lo = key_of(prev)?;
            hi = key_of(next)?;
        }
    }
    let key = match (lo, hi) {
        (Some(a), Some(b)) => (a + b) / 2.0,
        (Some(a), None) => a + SORT_STEP,
        (None, Some(b)) => b - SORT_STEP,
        (None, None) => return Ok(()),
    };
    c.execute(
        "UPDATE tasks SET sort_key = ?1 WHERE id = ?2",
        params![key, tid],
    )?;
    Ok(())
}

/// Tell everyone who has the project open (editor or board) that issues changed.
fn changed(app: &Shared, pid: &str, user: &AuthUser, task: Option<i64>) {
    app.hub
        .broadcast(pid, &json!({ "t": "tasks", "by": user.id, "task": task }));
}

/// Let a new assignee know, if they have the project open.
fn announce(app: &Shared, pid: &str, user: &AuthUser, to: i64, key: &str, task: &Value) {
    if to == user.id {
        return;
    }
    app.hub.broadcast(
        pid,
        &json!({
            "t": "task_assigned",
            "by": user.id,
            "by_name": user.display_name,
            "to": to,
            "task": task["id"],
            "num": task["num"],
            "key": format!("{key}-{}", task["num"]),
            "title": task["title"],
        }),
    );
}

// ---------------------------------------------------------------------------
// Board and issues
// ---------------------------------------------------------------------------

/// Everything a board needs in one request: project, members, sprints and all issues.
pub async fn board(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let uid = user.id;
    app.db
        .call(move |c| {
            let role = role_of(c, &pid, uid)?;
            let key = ensure_board(c, &pid)?;
            let name: String = c.query_row(
                "SELECT name FROM projects WHERE id = ?1",
                params![pid],
                |r| r.get(0),
            )?;
            let members = members_of(c, &pid)?;
            let sprints = sprints_of(c, &pid)?;
            let tasks = query_tasks(
                c,
                "t.project_id = ?1 ORDER BY t.sort_key, t.id",
                params![pid],
            )?;
            Ok(Json(json!({
                "project": { "id": pid, "name": name, "key": key, "role": role },
                "members": members,
                "sprints": sprints,
                "tasks": tasks,
            })))
        })
        .await
}

/// One issue with its description, child issues, comments and history.
pub async fn get_task(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, tid)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let uid = user.id;
    app.db
        .call(move |c| {
            let role = role_of(c, &pid, uid)?;
            let key = ensure_board(c, &pid)?;
            let mut task = one_task(c, &pid, tid)?;
            let description: String = c.query_row(
                "SELECT description FROM tasks WHERE id = ?1",
                params![tid],
                |r| r.get(0),
            )?;
            task["description"] = json!(description);
            let name: String = c.query_row(
                "SELECT name FROM projects WHERE id = ?1",
                params![pid],
                |r| r.get(0),
            )?;
            let children = query_tasks(
                c,
                "t.parent_id = ?1 ORDER BY t.sort_key, t.id",
                params![tid],
            )?;
            let comments = comments_of(c, tid)?;
            let activity = history_of(c, tid)?;
            let members = members_of(c, &pid)?;
            let sprints = sprints_of(c, &pid)?;
            let epics = epics_of(c, &pid)?;
            Ok(Json(json!({
                "project": { "id": pid, "name": name, "key": key, "role": role },
                "task": task,
                "children": children,
                "comments": comments,
                "activity": activity,
                "members": members,
                "sprints": sprints,
                "epics": epics,
            })))
        })
        .await
}

#[derive(Deserialize)]
pub struct CreateTaskReq {
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    assignee_id: Option<i64>,
    #[serde(default)]
    sprint_id: Option<i64>,
    #[serde(default)]
    parent_id: Option<i64>,
    #[serde(default)]
    start_date: Option<String>,
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    estimate: Option<i64>,
    #[serde(default)]
    labels: Vec<String>,
}

pub async fn create_task(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
    Json(req): Json<CreateTaskReq>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let title = clean_line(&req.title, 255, "summary")?;
    let description = clean_text(
        req.description.as_deref().unwrap_or(""),
        20_000,
        "description",
    )?;
    let kind = one_of(req.kind.as_deref().unwrap_or("task"), KINDS, "issue type")?;
    let status = one_of(req.status.as_deref().unwrap_or("todo"), STATUSES, "status")?;
    let priority = one_of(
        req.priority.as_deref().unwrap_or("medium"),
        PRIORITIES,
        "priority",
    )?;
    let start_date = clean_date(req.start_date.as_deref())?;
    let due_date = clean_date(req.due_date.as_deref())?;
    check_range(&start_date, &due_date, "due date")?;
    let estimate = check_estimate(req.estimate)?;
    let labels = clean_labels(&req.labels)?;
    if kind == "epic" && req.parent_id.is_some() {
        return Err(AppError::bad("an epic cannot belong to another epic"));
    }
    let (uid, assignee, sprint, parent) = (user.id, req.assignee_id, req.sprint_id, req.parent_id);
    let p = pid.clone();
    let (task, key) = app
        .db
        .call(move |c| {
            require_edit(role_of(c, &p, uid)?)?;
            let key = ensure_board(c, &p)?;
            if let Some(a) = assignee {
                if !is_member(c, &p, a)? {
                    return Err(AppError::bad(
                        "the assignee must be a member of this project",
                    ));
                }
            }
            if let Some(s) = sprint {
                check_sprint(c, &p, s)?;
            }
            if let Some(e) = parent {
                check_parent(c, &p, e)?;
            }
            let t = now();
            let resolved = (status == "done").then_some(t);
            let tx = c.transaction()?;
            let num: i64 = tx.query_row(
                "SELECT next_num FROM boards WHERE project_id = ?1",
                params![p],
                |r| r.get(0),
            )?;
            tx.execute(
                "UPDATE boards SET next_num = next_num + 1 WHERE project_id = ?1",
                params![p],
            )?;
            let sort_key = bottom_key(&tx, &p)?;
            tx.execute(
                "INSERT INTO tasks (project_id, num, title, description, kind, status, priority,
                     assignee_id, reporter_id, sprint_id, parent_id, start_date, due_date, estimate,
                     labels, sort_key, created_at, updated_at, resolved_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17, ?18)",
                params![
                    p, num, title, description, kind, status, priority, assignee, uid, sprint,
                    parent, start_date, due_date, estimate, labels, sort_key, t, resolved
                ],
            )?;
            let id = tx.last_insert_rowid();
            log_activity(&tx, id, uid, "created", None, None, t)?;
            tx.commit()?;
            Ok((one_task(c, &p, id)?, key))
        })
        .await?;
    changed(&app, &pid, &user, task["id"].as_i64());
    if let Some(a) = assignee {
        announce(&app, &pid, &user, a, &key, &task);
    }
    Ok(Json(task))
}

#[derive(Deserialize)]
pub struct Position {
    #[serde(default)]
    prev: Option<i64>,
    #[serde(default)]
    next: Option<i64>,
}

#[derive(Deserialize)]
pub struct UpdateTaskReq {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    assignee_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "nullable")]
    sprint_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "nullable")]
    parent_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "nullable")]
    start_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    due_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    estimate: Option<Option<i64>>,
    #[serde(default)]
    labels: Option<Vec<String>>,
    /// Drag and drop: the issues directly above and below the drop point.
    #[serde(default)]
    position: Option<Position>,
}

impl UpdateTaskReq {
    /// Viewers may move issues assigned to them, but not change anything else.
    fn only_moves(&self) -> bool {
        self.title.is_none()
            && self.description.is_none()
            && self.kind.is_none()
            && self.priority.is_none()
            && self.assignee_id.is_none()
            && self.sprint_id.is_none()
            && self.parent_id.is_none()
            && self.start_date.is_none()
            && self.due_date.is_none()
            && self.estimate.is_none()
            && self.labels.is_none()
    }
}

/// The editable columns of an issue, compared before and after an update.
#[derive(Clone, PartialEq)]
struct Fields {
    title: String,
    description: String,
    kind: String,
    status: String,
    priority: String,
    assignee_id: Option<i64>,
    sprint_id: Option<i64>,
    parent_id: Option<i64>,
    start_date: Option<String>,
    due_date: Option<String>,
    estimate: Option<i64>,
    labels: String,
    resolved_at: Option<i64>,
}

fn load_fields(c: &Connection, pid: &str, tid: i64) -> AppResult<Fields> {
    Ok(c.query_row(
        "SELECT title, description, kind, status, priority, assignee_id, sprint_id, parent_id,
                start_date, due_date, estimate, labels, resolved_at
         FROM tasks WHERE id = ?1 AND project_id = ?2",
        params![tid, pid],
        |r| {
            Ok(Fields {
                title: r.get(0)?,
                description: r.get(1)?,
                kind: r.get(2)?,
                status: r.get(3)?,
                priority: r.get(4)?,
                assignee_id: r.get(5)?,
                sprint_id: r.get(6)?,
                parent_id: r.get(7)?,
                start_date: r.get(8)?,
                due_date: r.get(9)?,
                estimate: r.get(10)?,
                labels: r.get(11)?,
                resolved_at: r.get(12)?,
            })
        },
    )?)
}

type Change = (&'static str, Option<String>, Option<String>);

/// Human-readable history entries for everything that differs between `old` and `new`.
fn describe_changes(
    c: &Connection,
    key: &str,
    old: &Fields,
    new: &Fields,
) -> AppResult<Vec<Change>> {
    let mut out: Vec<Change> = Vec::new();
    let mut plain = |field: &'static str, a: &str, b: &str| {
        if a != b {
            out.push((field, Some(a.to_string()), Some(b.to_string())));
        }
    };
    plain("title", &old.title, &new.title);
    plain("kind", &old.kind, &new.kind);
    plain("status", &old.status, &new.status);
    plain("priority", &old.priority, &new.priority);
    if old.description != new.description {
        out.push(("description", None, None));
    }
    if old.assignee_id != new.assignee_id {
        out.push((
            "assignee",
            user_name(c, old.assignee_id)?,
            user_name(c, new.assignee_id)?,
        ));
    }
    if old.sprint_id != new.sprint_id {
        out.push((
            "sprint",
            sprint_name(c, old.sprint_id)?,
            sprint_name(c, new.sprint_id)?,
        ));
    }
    if old.parent_id != new.parent_id {
        out.push((
            "parent",
            task_ref(c, key, old.parent_id)?,
            task_ref(c, key, new.parent_id)?,
        ));
    }
    if old.start_date != new.start_date {
        out.push(("start_date", old.start_date.clone(), new.start_date.clone()));
    }
    if old.due_date != new.due_date {
        out.push(("due_date", old.due_date.clone(), new.due_date.clone()));
    }
    if old.estimate != new.estimate {
        out.push((
            "estimate",
            old.estimate.map(|v| v.to_string()),
            new.estimate.map(|v| v.to_string()),
        ));
    }
    if old.labels != new.labels {
        let show = |s: &str| (!s.is_empty()).then(|| s.replace(',', ", "));
        out.push(("labels", show(&old.labels), show(&new.labels)));
    }
    Ok(out)
}

pub async fn update_task(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, tid)): Path<(String, i64)>,
    Json(req): Json<UpdateTaskReq>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let uid = user.id;
    let p = pid.clone();
    let (task, key, assigned) = app
        .db
        .call(move |c| {
            let role = role_of(c, &p, uid)?;
            let old = load_fields(c, &p, tid)?;
            if !role.can_edit() && !(req.only_moves() && old.assignee_id == Some(uid)) {
                return Err(AppError::forbidden(
                    "you have read-only access to this project and can only move issues assigned to you",
                ));
            }
            let key = ensure_board(c, &p)?;
            let mut new = old.clone();
            if let Some(v) = &req.title {
                new.title = clean_line(v, 255, "summary")?;
            }
            if let Some(v) = &req.description {
                new.description = clean_text(v, 20_000, "description")?;
            }
            if let Some(v) = &req.kind {
                new.kind = one_of(v, KINDS, "issue type")?;
            }
            if let Some(v) = &req.status {
                new.status = one_of(v, STATUSES, "status")?;
            }
            if let Some(v) = &req.priority {
                new.priority = one_of(v, PRIORITIES, "priority")?;
            }
            if let Some(v) = req.assignee_id {
                if let Some(a) = v {
                    if v != old.assignee_id && !is_member(c, &p, a)? {
                        return Err(AppError::bad(
                            "the assignee must be a member of this project",
                        ));
                    }
                }
                new.assignee_id = v;
            }
            if let Some(v) = req.sprint_id {
                if let Some(s) = v {
                    if v != old.sprint_id {
                        check_sprint(c, &p, s)?;
                    }
                }
                new.sprint_id = v;
            }
            if let Some(v) = req.parent_id {
                if let Some(e) = v {
                    if e == tid {
                        return Err(AppError::bad("an issue cannot be its own parent"));
                    }
                    if v != old.parent_id {
                        check_parent(c, &p, e)?;
                    }
                }
                new.parent_id = v;
            }
            if let Some(v) = &req.start_date {
                new.start_date = clean_date(v.as_deref())?;
            }
            if let Some(v) = &req.due_date {
                new.due_date = clean_date(v.as_deref())?;
            }
            if let Some(v) = req.estimate {
                new.estimate = check_estimate(v)?;
            }
            if let Some(v) = &req.labels {
                new.labels = clean_labels(v)?;
            }
            check_range(&new.start_date, &new.due_date, "due date")?;
            if new.kind == "epic" && new.parent_id.is_some() {
                return Err(AppError::bad("an epic cannot belong to another epic"));
            }
            if old.kind == "epic" && new.kind != "epic" && has_children(c, tid)? {
                return Err(AppError::bad(
                    "move this epic's child issues out before changing its type",
                ));
            }
            let t = now();
            new.resolved_at = match (old.status == "done", new.status == "done") {
                (false, true) => Some(t),
                (true, true) => old.resolved_at,
                (_, false) => None,
            };
            let changes = describe_changes(c, &key, &old, &new)?;
            let tx = c.transaction()?;
            if new != old {
                tx.execute(
                    "UPDATE tasks SET title = ?1, description = ?2, kind = ?3, status = ?4,
                         priority = ?5, assignee_id = ?6, sprint_id = ?7, parent_id = ?8,
                         start_date = ?9, due_date = ?10, estimate = ?11, labels = ?12,
                         resolved_at = ?13, updated_at = ?14
                     WHERE id = ?15",
                    params![
                        new.title,
                        new.description,
                        new.kind,
                        new.status,
                        new.priority,
                        new.assignee_id,
                        new.sprint_id,
                        new.parent_id,
                        new.start_date,
                        new.due_date,
                        new.estimate,
                        new.labels,
                        new.resolved_at,
                        t,
                        tid
                    ],
                )?;
                for (field, before, after) in &changes {
                    log_activity(&tx, tid, uid, field, before.as_deref(), after.as_deref(), t)?;
                }
            }
            if let Some(pos) = &req.position {
                place(&tx, &p, tid, pos.prev, pos.next)?;
            }
            tx.commit()?;
            let assigned = new.assignee_id.filter(|_| new.assignee_id != old.assignee_id);
            Ok((one_task(c, &p, tid)?, key, assigned))
        })
        .await?;
    changed(&app, &pid, &user, Some(tid));
    if let Some(a) = assigned {
        announce(&app, &pid, &user, a, &key, &task);
    }
    Ok(Json(task))
}

pub async fn delete_task(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, tid)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let uid = user.id;
    let p = pid.clone();
    app.db
        .call(move |c| {
            require_edit(role_of(c, &p, uid)?)?;
            let n = c.execute(
                "DELETE FROM tasks WHERE id = ?1 AND project_id = ?2",
                params![tid, p],
            )?;
            if n == 0 {
                return Err(AppError::NotFound);
            }
            Ok(())
        })
        .await?;
    changed(&app, &pid, &user, Some(tid));
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CommentReq {
    body: String,
}

fn clean_comment(body: &str) -> AppResult<String> {
    let b = clean_text(body, 10_000, "a comment")?;
    if b.is_empty() {
        return Err(AppError::bad("the comment is empty"));
    }
    Ok(b)
}

/// Every member can comment, including viewers (like the project chat).
pub async fn add_comment(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, tid)): Path<(String, i64)>,
    Json(req): Json<CommentReq>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let body = clean_comment(&req.body)?;
    let uid = user.id;
    let p = pid.clone();
    let comment = app
        .db
        .call(move |c| {
            role_of(c, &p, uid)?;
            task_exists(c, &p, tid)?;
            let t = now();
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO task_comments (task_id, user_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![tid, uid, body, t],
            )?;
            let id = tx.last_insert_rowid();
            tx.execute(
                "UPDATE tasks SET updated_at = ?1 WHERE id = ?2",
                params![t, tid],
            )?;
            log_activity(&tx, tid, uid, "comment", None, None, t)?;
            tx.commit()?;
            Ok(c.query_row(
                &format!("{COMMENT_SELECT} WHERE c.id = ?1"),
                params![id],
                comment_json,
            )?)
        })
        .await?;
    changed(&app, &pid, &user, Some(tid));
    Ok(Json(comment))
}

fn comment_author(c: &Connection, pid: &str, tid: i64, cid: i64) -> AppResult<i64> {
    Ok(c.query_row(
        "SELECT c.user_id FROM task_comments c JOIN tasks t ON t.id = c.task_id
         WHERE c.id = ?1 AND c.task_id = ?2 AND t.project_id = ?3",
        params![cid, tid, pid],
        |r| r.get(0),
    )?)
}

pub async fn edit_comment(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, tid, cid)): Path<(String, i64, i64)>,
    Json(req): Json<CommentReq>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let body = clean_comment(&req.body)?;
    let uid = user.id;
    let p = pid.clone();
    let comment = app
        .db
        .call(move |c| {
            role_of(c, &p, uid)?;
            if comment_author(c, &p, tid, cid)? != uid {
                return Err(AppError::forbidden("you can only edit your own comments"));
            }
            c.execute(
                "UPDATE task_comments SET body = ?1, edited_at = ?2 WHERE id = ?3",
                params![body, now(), cid],
            )?;
            Ok(c.query_row(
                &format!("{COMMENT_SELECT} WHERE c.id = ?1"),
                params![cid],
                comment_json,
            )?)
        })
        .await?;
    changed(&app, &pid, &user, Some(tid));
    Ok(Json(comment))
}

/// Authors can delete their comments; the project owner can delete any comment.
pub async fn delete_comment(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, tid, cid)): Path<(String, i64, i64)>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let uid = user.id;
    let p = pid.clone();
    app.db
        .call(move |c| {
            let role = role_of(c, &p, uid)?;
            if comment_author(c, &p, tid, cid)? != uid && role != Role::Owner {
                return Err(AppError::forbidden(
                    "only the author or the project owner can delete this comment",
                ));
            }
            c.execute("DELETE FROM task_comments WHERE id = ?1", params![cid])?;
            Ok(())
        })
        .await?;
    changed(&app, &pid, &user, Some(tid));
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SprintReq {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    goal: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    start_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    end_date: Option<Option<String>>,
    /// "active" starts a planned sprint, "closed" completes the active one.
    #[serde(default)]
    state: Option<String>,
    /// When completing: where unfinished issues go (another sprint, or the backlog if absent).
    #[serde(default)]
    move_to: Option<i64>,
}

pub async fn create_sprint(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
    Json(req): Json<SprintReq>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let name = req
        .name
        .as_deref()
        .map(|n| clean_line(n, 80, "the sprint name"))
        .transpose()?;
    let goal = clean_text(req.goal.as_deref().unwrap_or(""), 1000, "the sprint goal")?;
    let start = clean_date(req.start_date.flatten().as_deref())?;
    let end = clean_date(req.end_date.flatten().as_deref())?;
    check_range(&start, &end, "end date")?;
    let uid = user.id;
    let p = pid.clone();
    let sprint = app
        .db
        .call(move |c| {
            require_edit(role_of(c, &p, uid)?)?;
            let key = ensure_board(c, &p)?;
            let count: i64 = c.query_row(
                "SELECT COUNT(*) FROM sprints WHERE project_id = ?1",
                params![p],
                |r| r.get(0),
            )?;
            let name = name.unwrap_or_else(|| format!("{key} Sprint {}", count + 1));
            c.execute(
                "INSERT INTO sprints (project_id, name, goal, state, start_date, end_date, created_at)
                 VALUES (?1, ?2, ?3, 'planned', ?4, ?5, ?6)",
                params![p, name, goal, start, end, now()],
            )?;
            let sid = c.last_insert_rowid();
            one_sprint(c, sid)
        })
        .await?;
    changed(&app, &pid, &user, None);
    Ok(Json(sprint))
}

pub async fn update_sprint(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, sid)): Path<(String, i64)>,
    Json(req): Json<SprintReq>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let name = req
        .name
        .as_deref()
        .map(|n| clean_line(n, 80, "the sprint name"))
        .transpose()?;
    let goal = req
        .goal
        .as_deref()
        .map(|g| clean_text(g, 1000, "the sprint goal"))
        .transpose()?;
    let start = req
        .start_date
        .map(|d| clean_date(d.as_deref()))
        .transpose()?;
    let end = req.end_date.map(|d| clean_date(d.as_deref())).transpose()?;
    if let Some(s) = req.state.as_deref() {
        if s != "active" && s != "closed" {
            return Err(AppError::bad("state must be 'active' or 'closed'"));
        }
    }
    let (state, move_to) = (req.state, req.move_to);
    let uid = user.id;
    let p = pid.clone();
    let sprint = app
        .db
        .call(move |c| {
            require_edit(role_of(c, &p, uid)?)?;
            let (cur, cur_start, cur_end): (String, Option<String>, Option<String>) = c.query_row(
                "SELECT state, start_date, end_date FROM sprints WHERE id = ?1 AND project_id = ?2",
                params![sid, p],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            let start = start.unwrap_or(cur_start);
            let end = end.unwrap_or(cur_end);
            check_range(&start, &end, "end date")?;
            let t = now();
            let tx = c.transaction()?;
            if let Some(n) = name {
                tx.execute("UPDATE sprints SET name = ?1 WHERE id = ?2", params![n, sid])?;
            }
            if let Some(g) = goal {
                tx.execute("UPDATE sprints SET goal = ?1 WHERE id = ?2", params![g, sid])?;
            }
            tx.execute(
                "UPDATE sprints SET start_date = ?1, end_date = ?2 WHERE id = ?3",
                params![start, end, sid],
            )?;
            match state.as_deref() {
                Some("active") if cur != "active" => {
                    if cur != "planned" {
                        return Err(AppError::bad("a completed sprint cannot be restarted"));
                    }
                    if start.is_none() || end.is_none() {
                        return Err(AppError::bad(
                            "set the start and end dates before starting the sprint",
                        ));
                    }
                    let busy: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM sprints WHERE project_id = ?1 AND state = 'active')",
                        params![p],
                        |r| r.get(0),
                    )?;
                    if busy {
                        return Err(AppError::conflict(
                            "another sprint is already active, complete it first",
                        ));
                    }
                    tx.execute(
                        "UPDATE sprints SET state = 'active' WHERE id = ?1",
                        params![sid],
                    )?;
                }
                Some("closed") if cur != "closed" => {
                    if cur != "active" {
                        return Err(AppError::bad("only the active sprint can be completed"));
                    }
                    if let Some(target) = move_to {
                        if target == sid {
                            return Err(AppError::bad(
                                "choose another sprint for the unfinished issues",
                            ));
                        }
                        check_sprint(&tx, &p, target)?;
                    }
                    tx.execute(
                        "UPDATE tasks SET sprint_id = ?1, updated_at = ?2
                         WHERE sprint_id = ?3 AND status != 'done'",
                        params![move_to, t, sid],
                    )?;
                    tx.execute(
                        "UPDATE sprints SET state = 'closed', completed_at = ?1 WHERE id = ?2",
                        params![t, sid],
                    )?;
                }
                _ => {}
            }
            tx.commit()?;
            one_sprint(c, sid)
        })
        .await?;
    changed(&app, &pid, &user, None);
    Ok(Json(sprint))
}

/// Only sprints that have not started can be deleted; their issues return to the backlog.
pub async fn delete_sprint(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, sid)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let uid = user.id;
    let p = pid.clone();
    app.db
        .call(move |c| {
            require_edit(role_of(c, &p, uid)?)?;
            let state: String = c.query_row(
                "SELECT state FROM sprints WHERE id = ?1 AND project_id = ?2",
                params![sid, p],
                |r| r.get(0),
            )?;
            if state != "planned" {
                return Err(AppError::bad(
                    "only sprints that have not started can be deleted",
                ));
            }
            let tx = c.transaction()?;
            tx.execute(
                "UPDATE tasks SET sprint_id = NULL WHERE sprint_id = ?1",
                params![sid],
            )?;
            tx.execute("DELETE FROM sprints WHERE id = ?1", params![sid])?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    changed(&app, &pid, &user, None);
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Board settings, activity, personal overview
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct BoardReq {
    key: String,
}

pub async fn update_board(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
    Json(req): Json<BoardReq>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let key = clean_key(&req.key)?;
    let uid = user.id;
    let (p, k) = (pid.clone(), key.clone());
    app.db
        .call(move |c| {
            require_edit(role_of(c, &p, uid)?)?;
            ensure_board(c, &p)?;
            c.execute(
                "UPDATE boards SET task_key = ?1 WHERE project_id = ?2",
                params![k, p],
            )?;
            Ok(())
        })
        .await?;
    changed(&app, &pid, &user, None);
    Ok(Json(json!({ "key": key })))
}

/// The latest changes across all issues of a project.
pub async fn activity(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
) -> AppResult<Json<Value>> {
    check_pid(&pid)?;
    let uid = user.id;
    app.db
        .call(move |c| {
            role_of(c, &pid, uid)?;
            let mut st = c.prepare(
                "SELECT a.id, a.user_id, u.display_name, a.field, a.old_value, a.new_value,
                        a.created_at, t.id, t.num, t.title, t.kind
                 FROM task_activity a
                 JOIN tasks t ON t.id = a.task_id
                 LEFT JOIN users u ON u.id = a.user_id
                 WHERE t.project_id = ?1
                 ORDER BY a.id DESC LIMIT 40",
            )?;
            let rows = st.query_map(params![pid], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "user_id": r.get::<_, Option<i64>>(1)?,
                    "name": r.get::<_, Option<String>>(2)?,
                    "field": r.get::<_, String>(3)?,
                    "old": r.get::<_, Option<String>>(4)?,
                    "new": r.get::<_, Option<String>>(5)?,
                    "created_at": r.get::<_, i64>(6)?,
                    "task_id": r.get::<_, i64>(7)?,
                    "num": r.get::<_, i64>(8)?,
                    "title": r.get::<_, String>(9)?,
                    "kind": r.get::<_, String>(10)?,
                }))
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(Json(Value::Array(out)))
        })
        .await
}

fn my_projects(c: &Connection, uid: i64) -> AppResult<Vec<Value>> {
    let mut st = c.prepare(
        "SELECT p.id, p.name, b.task_key, CASE WHEN p.owner_id = ?1 THEN 'owner' ELSE m.role END
         FROM projects p
         LEFT JOIN members m ON m.project_id = p.id AND m.user_id = ?1
         LEFT JOIN boards b ON b.project_id = p.id
         WHERE p.owner_id = ?1 OR m.user_id IS NOT NULL
         ORDER BY p.name COLLATE NOCASE",
    )?;
    let rows = st.query_map(params![uid], |r| {
        let name: String = r.get(1)?;
        let key = r
            .get::<_, Option<String>>(2)?
            .unwrap_or_else(|| default_key(&name));
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "name": name,
            "key": key,
            "role": r.get::<_, String>(3)?,
        }))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Issues assigned to or reported by the current user, across every project they can access.
/// Finished issues are included for 30 days.
pub async fn mine(State(app): State<Shared>, user: AuthUser) -> AppResult<Json<Value>> {
    let uid = user.id;
    let since = now() - 30 * 86_400;
    app.db
        .call(move |c| {
            let tasks = query_tasks(
                c,
                "(t.assignee_id = ?1 OR t.reporter_id = ?1)
                 AND (t.status != 'done' OR t.resolved_at >= ?2)
                 AND t.project_id IN (SELECT id FROM projects WHERE owner_id = ?1
                                      UNION SELECT project_id FROM members WHERE user_id = ?1)
                 ORDER BY t.updated_at DESC LIMIT 1000",
                params![uid, since],
            )?;
            let projects = my_projects(c, uid)?;
            Ok(Json(json!({ "tasks": tasks, "projects": projects })))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert!(valid_date("2026-10-08"));
        assert!(valid_date("2024-02-29"));
        assert!(!valid_date("2023-02-29"));
        assert!(!valid_date("2026-13-01"));
        assert!(!valid_date("2026-1-01"));
        assert!(!valid_date("+026-10-08"));
        assert!(!valid_date(""));
        assert_eq!(clean_date(Some(" ")).unwrap(), None);
        assert!(clean_date(Some("tomorrow")).is_err());
    }

    #[test]
    fn keys() {
        assert_eq!(default_key("My Thesis"), "MT");
        assert_eq!(default_key("thesis"), "THES");
        assert_eq!(default_key("2026 annual report draft v2"), "ARDV");
        assert_eq!(default_key("x"), "TASK");
        assert_eq!(default_key("Überblick"), "BERB");
        assert_eq!(clean_key(" ul ").unwrap(), "UL");
        assert!(clean_key("1AB").is_err());
        assert!(clean_key("A").is_err());
        assert!(clean_key("A-B").is_err());
    }

    #[test]
    fn labels() {
        fn l(v: &[&str]) -> AppResult<String> {
            clean_labels(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        }
        assert_eq!(
            l(&["Chapter 2", "figures", "", "FIGURES"]).unwrap(),
            "Chapter-2,figures"
        );
        assert_eq!(l(&["a,b"]).unwrap(), "ab");
        assert_eq!(split_labels(""), Vec::<String>::new());
        assert_eq!(split_labels("x,y"), vec!["x", "y"]);
    }
}
