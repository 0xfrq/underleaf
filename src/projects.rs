use std::collections::HashMap;

use axum::{
    extract::{Path, State},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    files,
    util::{is_valid_id, latex_escape, new_id, now},
    Shared,
};

pub const COMPILERS: &[&str] = &["pdflatex", "xelatex", "lualatex"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Editor,
    Viewer,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "owner" => Some(Role::Owner),
            "editor" => Some(Role::Editor),
            "viewer" => Some(Role::Viewer),
            _ => None,
        }
    }

    pub fn can_edit(self) -> bool {
        self != Role::Viewer
    }
}

pub fn role_of(c: &Connection, pid: &str, uid: i64) -> AppResult<Role> {
    let r: Option<Option<String>> = c
        .query_row(
            "SELECT CASE WHEN p.owner_id = ?2 THEN 'owner'
                    ELSE (SELECT role FROM members WHERE project_id = p.id AND user_id = ?2) END
             FROM projects p WHERE p.id = ?1",
            params![pid, uid],
            |r| r.get(0),
        )
        .optional()?;
    r.flatten()
        .as_deref()
        .and_then(Role::parse)
        .ok_or(AppError::NotFound)
}

pub async fn require_role(app: &Shared, pid: &str, uid: i64) -> AppResult<Role> {
    if !is_valid_id(pid) {
        return Err(AppError::NotFound);
    }
    let pid = pid.to_string();
    app.db.call(move |c| role_of(c, &pid, uid)).await
}

pub async fn require_editor(app: &Shared, pid: &str, uid: i64) -> AppResult<Role> {
    let role = require_role(app, pid, uid).await?;
    if !role.can_edit() {
        return Err(AppError::forbidden(
            "you have read-only access to this project",
        ));
    }
    Ok(role)
}

pub fn touch(c: &Connection, pid: &str, t: i64) -> AppResult<()> {
    c.execute(
        "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
        params![t, pid],
    )?;
    Ok(())
}

fn clean_project_name(name: &str) -> AppResult<String> {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if n.is_empty() || n.chars().count() > 150 {
        return Err(AppError::bad("project name must be 1-150 characters"));
    }
    Ok(n)
}

pub fn members_of(c: &Connection, pid: &str) -> AppResult<Vec<Value>> {
    let mut st = c.prepare_cached(
        "SELECT u.id, u.username, u.display_name, 'owner'
         FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?1
         UNION ALL
         SELECT u.id, u.username, u.display_name, m.role
         FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?1",
    )?;
    let rows = st.query_map(params![pid], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "username": r.get::<_, String>(1)?,
            "display_name": r.get::<_, String>(2)?,
            "role": r.get::<_, String>(3)?,
        }))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TPL_ARTICLE: &str = r"\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[margin=2.5cm]{geometry}
\usepackage{hyperref}

\title{%TITLE%}
\author{%AUTHOR%}
\date{\today}

\begin{document}

\maketitle

\begin{abstract}
Write a short summary of your work here.
\end{abstract}

\section{Introduction}
Start writing here. Press \texttt{Ctrl+S} to compile.

\section{Mathematics}
Inline math like $e^{i\pi} + 1 = 0$, or display math:
\begin{equation}
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
\end{equation}

\end{document}
";

const TPL_REPORT: &str = r"\documentclass[11pt,a4paper]{report}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[margin=2.5cm]{geometry}
\usepackage{hyperref}

\title{%TITLE%}
\author{%AUTHOR%}
\date{\today}

\begin{document}

\maketitle
\tableofcontents

\chapter{Introduction}
Start writing here.

\chapter{Conclusion}

\end{document}
";

const TPL_BEAMER: &str = r"\documentclass{beamer}
\usetheme{Madrid}

\title{%TITLE%}
\author{%AUTHOR%}
\date{\today}

\begin{document}

\frame{\titlepage}

\begin{frame}{Outline}
  \tableofcontents
\end{frame}

\section{Introduction}
\begin{frame}{Introduction}
  \begin{itemize}
    \item First point
    \item Second point
  \end{itemize}
\end{frame}

\end{document}
";

const TPL_BLANK: &str = r"\documentclass{article}

\begin{document}


\end{document}
";

fn template(kind: &str, title: &str, author: &str) -> String {
    let tpl = match kind {
        "blank" => TPL_BLANK,
        "report" => TPL_REPORT,
        "beamer" => TPL_BEAMER,
        _ => TPL_ARTICLE,
    };
    tpl.replace("%TITLE%", &latex_escape(title))
        .replace("%AUTHOR%", &latex_escape(author))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn list(State(app): State<Shared>, user: AuthUser) -> AppResult<Json<Value>> {
    let uid = user.id;
    app.db
        .call(move |c| {
            let mut st = c.prepare(
                "SELECT p.id, p.name, p.updated_at, u.display_name,
                        CASE WHEN p.owner_id = ?1 THEN 'owner' ELSE m.role END
                 FROM projects p
                 JOIN users u ON u.id = p.owner_id
                 LEFT JOIN members m ON m.project_id = p.id AND m.user_id = ?1
                 WHERE p.owner_id = ?1 OR m.user_id IS NOT NULL
                 ORDER BY p.updated_at DESC",
            )?;
            let rows = st.query_map(params![uid], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "updated_at": r.get::<_, i64>(2)?,
                    "owner": r.get::<_, String>(3)?,
                    "role": r.get::<_, String>(4)?,
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

#[derive(Deserialize)]
pub struct CreateReq {
    name: String,
    #[serde(default)]
    template: Option<String>,
}

pub async fn create(
    State(app): State<Shared>,
    user: AuthUser,
    Json(req): Json<CreateReq>,
) -> AppResult<Json<Value>> {
    let name = clean_project_name(&req.name)?;
    let content = template(
        req.template.as_deref().unwrap_or("article"),
        &name,
        &user.display_name,
    );
    let pid = new_id();
    let fid = new_id();
    let t = now();
    let uid = user.id;
    let p = pid.clone();
    app.db
        .call(move |c| {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO projects (id, name, owner_id, main_file, compiler, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'pdflatex', ?5, ?5)",
                params![p, name, uid, fid, t],
            )?;
            tx.execute(
                "INSERT INTO files (id, project_id, parent_id, name, kind, content, size, updated_at)
                 VALUES (?1, ?2, NULL, 'main.tex', 'doc', ?3, ?4, ?5)",
                params![fid, p, content, content.len() as i64, t],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "id": pid })))
}

pub async fn get(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
) -> AppResult<Json<Value>> {
    if !is_valid_id(&pid) {
        return Err(AppError::NotFound);
    }
    let uid = user.id;
    app.db
        .call(move |c| {
            let role = role_of(c, &pid, uid)?;
            let (name, owner_id, main_file, compiler, created_at, updated_at): (
                String,
                i64,
                Option<String>,
                String,
                i64,
                i64,
            ) = c.query_row(
                "SELECT name, owner_id, main_file, compiler, created_at, updated_at
                 FROM projects WHERE id = ?1",
                params![pid],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )?;
            let members = members_of(c, &pid)?;
            let tree = files::load_tree(c, &pid)?;
            Ok(Json(json!({
                "id": pid,
                "name": name,
                "owner_id": owner_id,
                "main_file": main_file,
                "compiler": compiler,
                "created_at": created_at,
                "updated_at": updated_at,
                "role": role,
                "members": members,
                "tree": tree,
            })))
        })
        .await
}

#[derive(Deserialize)]
pub struct UpdateReq {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    main_file: Option<String>,
    #[serde(default)]
    compiler: Option<String>,
}

pub async fn update(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
    Json(req): Json<UpdateReq>,
) -> AppResult<Json<Value>> {
    require_editor(&app, &pid, user.id).await?;
    let name = match req.name {
        Some(n) => Some(clean_project_name(&n)?),
        None => None,
    };
    if let Some(cmp) = &req.compiler {
        if !COMPILERS.contains(&cmp.as_str()) {
            return Err(AppError::bad("unknown compiler"));
        }
    }
    let p = pid.clone();
    let main_file = req.main_file;
    let compiler = req.compiler;
    app.db
        .call(move |c| {
            let tx = c.transaction()?;
            if let Some(n) = name {
                tx.execute("UPDATE projects SET name = ?1 WHERE id = ?2", params![n, p])?;
            }
            if let Some(m) = main_file {
                if m.is_empty() {
                    tx.execute(
                        "UPDATE projects SET main_file = NULL WHERE id = ?1",
                        params![p],
                    )?;
                } else {
                    let kind: Option<String> = tx
                        .query_row(
                            "SELECT kind FROM files WHERE id = ?1 AND project_id = ?2",
                            params![m, p],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if kind.as_deref() != Some("doc") {
                        return Err(AppError::bad("main document must be a text file"));
                    }
                    tx.execute(
                        "UPDATE projects SET main_file = ?1 WHERE id = ?2",
                        params![m, p],
                    )?;
                }
            }
            if let Some(cmp) = compiler {
                tx.execute(
                    "UPDATE projects SET compiler = ?1 WHERE id = ?2",
                    params![cmp, p],
                )?;
            }
            touch(&tx, &p, now())?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    app.hub.broadcast(&pid, &json!({ "t": "project" }));
    Ok(Json(json!({ "ok": true })))
}

pub async fn remove(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
) -> AppResult<Json<Value>> {
    let role = require_role(&app, &pid, user.id).await?;
    if role != Role::Owner {
        return Err(AppError::forbidden("only the owner can delete a project"));
    }
    let p = pid.clone();
    app.db
        .call(move |c| {
            c.execute("DELETE FROM projects WHERE id = ?1", params![p])?;
            Ok(())
        })
        .await?;
    app.hub.drop_project(&pid);
    let _ = tokio::fs::remove_dir_all(app.cfg.compile_dir().join(&pid)).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct CopyReq {
    #[serde(default)]
    name: Option<String>,
}

pub async fn copy(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
    Json(req): Json<CopyReq>,
) -> AppResult<Json<Value>> {
    require_role(&app, &pid, user.id).await?;
    let new_name = match req.name {
        Some(n) => Some(clean_project_name(&n)?),
        None => None,
    };
    let live = app.hub.live_texts(&pid);
    let new_pid = new_id();
    let np = new_pid.clone();
    let uid = user.id;
    app.db
        .call(move |c| {
            let (name, main_file, compiler): (String, Option<String>, String) = c.query_row(
                "SELECT name, main_file, compiler FROM projects WHERE id = ?1",
                params![pid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            let rows = files::load_full(c, &pid)?;
            let idmap: HashMap<String, String> =
                rows.iter().map(|r| (r.id.clone(), new_id())).collect();
            let name = new_name.unwrap_or_else(|| format!("{name} (copy)"));
            let main = main_file.and_then(|m| idmap.get(&m).cloned());
            let t = now();
            let tx = c.transaction()?;
            tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
            tx.execute(
                "INSERT INTO projects (id, name, owner_id, main_file, compiler, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![np, name, uid, main, compiler, t],
            )?;
            {
                let mut ins = tx.prepare(
                    "INSERT INTO files (id, project_id, parent_id, name, kind, content, blob_hash, size, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )?;
                for r in rows {
                    let id = &idmap[&r.id];
                    let parent = r.parent_id.as_ref().and_then(|p| idmap.get(p));
                    let content = if r.kind == "doc" {
                        live.get(&r.id).cloned().or(r.content)
                    } else {
                        None
                    };
                    let size = content.as_ref().map(|s| s.len() as i64).unwrap_or(r.size);
                    ins.execute(params![
                        id, np, parent, r.name, r.kind, content, r.blob_hash, size, t
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "id": new_pid })))
}

#[derive(Deserialize)]
pub struct MemberReq {
    username: String,
    role: String,
}

pub async fn add_member(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
    Json(req): Json<MemberReq>,
) -> AppResult<Json<Value>> {
    let role = require_role(&app, &pid, user.id).await?;
    if role != Role::Owner {
        return Err(AppError::forbidden("only the owner can share this project"));
    }
    if req.role != "editor" && req.role != "viewer" {
        return Err(AppError::bad("role must be 'editor' or 'viewer'"));
    }
    let p = pid.clone();
    let username = req.username.trim().to_string();
    let new_role = req.role;
    let target = app
        .db
        .call(move |c| {
            let target: Option<i64> = c
                .query_row(
                    "SELECT id FROM users WHERE username = ?1",
                    params![username],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(target) = target else {
                return Err(AppError::bad("no user with that username"));
            };
            let owner: i64 = c.query_row(
                "SELECT owner_id FROM projects WHERE id = ?1",
                params![p],
                |r| r.get(0),
            )?;
            if owner == target {
                return Err(AppError::bad("that user already owns this project"));
            }
            c.execute(
                "INSERT INTO members (project_id, user_id, role) VALUES (?1, ?2, ?3)
                 ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role",
                params![p, target, new_role],
            )?;
            Ok(target)
        })
        .await?;
    // Make the user reconnect so that their new role takes effect immediately.
    app.hub.kick_user(&pid, target);
    app.hub.broadcast(&pid, &json!({ "t": "project" }));
    Ok(Json(json!({ "ok": true })))
}

pub async fn remove_member(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, uid)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let role = require_role(&app, &pid, user.id).await?;
    if role != Role::Owner && uid != user.id {
        return Err(AppError::forbidden(
            "only the owner can remove collaborators",
        ));
    }
    let p = pid.clone();
    app.db
        .call(move |c| {
            c.execute(
                "DELETE FROM members WHERE project_id = ?1 AND user_id = ?2",
                params![p, uid],
            )?;
            Ok(())
        })
        .await?;
    app.hub.kick_user(&pid, uid);
    app.hub.broadcast(&pid, &json!({ "t": "project" }));
    Ok(Json(json!({ "ok": true })))
}

pub async fn chat_history(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
) -> AppResult<Json<Value>> {
    require_role(&app, &pid, user.id).await?;
    app.db
        .call(move |c| {
            let mut st = c.prepare(
                "SELECT c.id, c.user_id, u.display_name, c.body, c.created_at
                 FROM chat c JOIN users u ON u.id = c.user_id
                 WHERE c.project_id = ?1 ORDER BY c.id DESC LIMIT 200",
            )?;
            let rows = st.query_map(params![pid], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "user_id": r.get::<_, i64>(1)?,
                    "name": r.get::<_, String>(2)?,
                    "body": r.get::<_, String>(3)?,
                    "created_at": r.get::<_, i64>(4)?,
                }))
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            out.reverse();
            Ok(Json(Value::Array(out)))
        })
        .await
}
