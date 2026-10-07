use std::{
    collections::HashMap,
    fs, io,
    path::{Path as FsPath, PathBuf},
};

use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{header, HeaderValue},
    response::Response,
    Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    projects::{require_editor, require_role, touch},
    util::{
        content_disposition, extension, is_valid_id, new_id, normalize_newlines, now, random_hex,
        sha256_hex, valid_name,
    },
    Shared,
};

/// Extensions that are stored as editable text documents.
const TEXT_EXT: &[&str] = &[
    "tex",
    "bib",
    "sty",
    "cls",
    "bst",
    "bbx",
    "cbx",
    "lbx",
    "def",
    "cfg",
    "clo",
    "dtx",
    "ins",
    "fd",
    "ltx",
    "txt",
    "md",
    "markdown",
    "csv",
    "tsv",
    "dat",
    "json",
    "yaml",
    "yml",
    "xml",
    "lua",
    "py",
    "r",
    "rnw",
    "tikz",
    "pgf",
    "gp",
    "gnuplot",
    "asy",
    "mp",
    "bbl",
    "ist",
    "gls",
    "glo",
    "sh",
    "toml",
    "ini",
    "html",
    "css",
    "js",
    "latexmkrc",
    "rtex",
    "lco",
    "bibtex",
];

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub size: i64,
    pub updated_at: i64,
}

/// A file row including its content; used by compile, export and copy.
pub struct FullRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub content: Option<String>,
    pub blob_hash: Option<String>,
    pub size: i64,
}

pub enum FileContent {
    Doc(String),
    Blob { hash: String, size: i64 },
}

pub fn load_tree(c: &Connection, pid: &str) -> AppResult<Vec<Entry>> {
    let mut st = c.prepare_cached(
        "SELECT id, parent_id, name, kind, size, updated_at FROM files WHERE project_id = ?1",
    )?;
    let rows = st.query_map(params![pid], |r| {
        Ok(Entry {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            name: r.get(2)?,
            kind: r.get(3)?,
            size: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn load_full(c: &Connection, pid: &str) -> AppResult<Vec<FullRow>> {
    let mut st = c.prepare_cached(
        "SELECT id, parent_id, name, kind, content, blob_hash, size FROM files WHERE project_id = ?1",
    )?;
    let rows = st.query_map(params![pid], |r| {
        Ok(FullRow {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            name: r.get(2)?,
            kind: r.get(3)?,
            content: r.get(4)?,
            blob_hash: r.get(5)?,
            size: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Build "a/b/c.tex" style paths for every node. Nodes with a broken parent chain are skipped.
pub fn build_paths<'a, I>(items: I) -> HashMap<String, String>
where
    I: IntoIterator<Item = (&'a str, Option<&'a str>, &'a str)>,
{
    let nodes: HashMap<&str, (Option<&str>, &str)> =
        items.into_iter().map(|(i, p, n)| (i, (p, n))).collect();
    let mut out = HashMap::with_capacity(nodes.len());
    for &id in nodes.keys() {
        let mut parts: Vec<&str> = Vec::new();
        let mut cur = Some(id);
        let mut ok = true;
        while let Some(c) = cur {
            match nodes.get(c) {
                Some(&(parent, name)) => {
                    parts.push(name);
                    cur = parent;
                    if parts.len() > 64 {
                        ok = false;
                        break;
                    }
                }
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            parts.reverse();
            out.insert(id.to_string(), parts.join("/"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Blob storage (content addressed, deduplicated)
// ---------------------------------------------------------------------------

pub fn blob_path(blobs: &FsPath, hash: &str) -> PathBuf {
    blobs.join(&hash[..2.min(hash.len())]).join(hash)
}

pub fn store_blob(blobs: &FsPath, data: &[u8]) -> io::Result<String> {
    let hash = sha256_hex(data);
    let path = blob_path(blobs, &hash);
    if !path.exists() {
        let dir = path.parent().unwrap_or(blobs);
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!("{hash}.{}.tmp", random_hex(4)));
        fs::write(&tmp, data)?;
        fs::rename(&tmp, &path)?;
    }
    Ok(hash)
}

/// Decide whether an uploaded file becomes an editable document or a binary blob.
pub fn classify(
    blobs: &FsPath,
    name: &str,
    data: Vec<u8>,
    max_doc: usize,
) -> io::Result<FileContent> {
    let ext = extension(name);
    let texty = TEXT_EXT.contains(&ext.as_str());
    let no_ext = ext.is_empty();
    if data.len() <= max_doc && (texty || no_ext) && !data.contains(&0) {
        match String::from_utf8(data) {
            Ok(s) => return Ok(FileContent::Doc(normalize_newlines(s))),
            Err(e) => {
                let data = e.into_bytes();
                if texty {
                    // Legacy Latin-1 sources: decode byte-for-byte.
                    let s: String = data.iter().map(|&b| b as char).collect();
                    return Ok(FileContent::Doc(normalize_newlines(s)));
                }
                let hash = store_blob(blobs, &data)?;
                return Ok(FileContent::Blob {
                    hash,
                    size: data.len() as i64,
                });
            }
        }
    }
    let hash = store_blob(blobs, &data)?;
    Ok(FileContent::Blob {
        hash,
        size: data.len() as i64,
    })
}

// ---------------------------------------------------------------------------
// Tree helpers (all run inside a DB transaction)
// ---------------------------------------------------------------------------

fn norm_parent(p: Option<String>) -> Option<String> {
    p.filter(|s| !s.is_empty())
}

pub fn find_child(
    c: &Connection,
    pid: &str,
    parent: Option<&str>,
    name: &str,
) -> AppResult<Option<(String, String)>> {
    Ok(c.query_row(
        "SELECT id, kind FROM files
         WHERE project_id = ?1 AND IFNULL(parent_id, '') = IFNULL(?2, '') AND name = ?3",
        params![pid, parent, name],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?)
}

fn check_folder(c: &Connection, pid: &str, folder: Option<&str>) -> AppResult<()> {
    if let Some(f) = folder {
        let kind: Option<String> = c
            .query_row(
                "SELECT kind FROM files WHERE id = ?1 AND project_id = ?2",
                params![f, pid],
                |r| r.get(0),
            )
            .optional()?;
        if kind.as_deref() != Some("folder") {
            return Err(AppError::bad("target folder does not exist"));
        }
    }
    Ok(())
}

/// Make sure the folder chain `comps` exists below `parent`; returns the innermost folder id.
pub fn ensure_folders(
    c: &Connection,
    pid: &str,
    mut parent: Option<String>,
    comps: &[String],
    t: i64,
) -> AppResult<Option<String>> {
    for name in comps {
        let next = match find_child(c, pid, parent.as_deref(), name)? {
            Some((id, kind)) if kind == "folder" => id,
            Some(_) => {
                return Err(AppError::conflict(format!(
                    "'{name}' exists and is not a folder"
                )))
            }
            None => {
                let id = new_id();
                c.execute(
                    "INSERT INTO files (id, project_id, parent_id, name, kind, size, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 'folder', 0, ?5)",
                    params![id, pid, parent, name, t],
                )?;
                id
            }
        };
        parent = Some(next);
    }
    Ok(parent)
}

/// Create or overwrite a file. Returns (id, previous kind if it existed).
pub fn upsert_file(
    c: &Connection,
    pid: &str,
    parent: Option<&str>,
    name: &str,
    content: &FileContent,
    t: i64,
) -> AppResult<(String, Option<String>)> {
    let (kind, text, hash, size) = match content {
        FileContent::Doc(s) => ("doc", Some(s.as_str()), None, s.len() as i64),
        FileContent::Blob { hash, size } => ("blob", None, Some(hash.as_str()), *size),
    };
    match find_child(c, pid, parent, name)? {
        Some((_, k)) if k == "folder" => Err(AppError::conflict(format!(
            "a folder named '{name}' already exists"
        ))),
        Some((id, k)) => {
            c.execute(
                "UPDATE files SET kind = ?1, content = ?2, blob_hash = ?3, size = ?4, updated_at = ?5
                 WHERE id = ?6",
                params![kind, text, hash, size, t, id],
            )?;
            Ok((id, Some(k)))
        }
        None => {
            let id = new_id();
            c.execute(
                "INSERT INTO files (id, project_id, parent_id, name, kind, content, blob_hash, size, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id, pid, parent, name, kind, text, hash, size, t],
            )?;
            Ok((id, None))
        }
    }
}

/// Split a client-supplied relative path into validated components.
pub fn split_path(rel: &str) -> AppResult<Vec<String>> {
    let comps: Vec<String> = rel
        .split(['/', '\\'])
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != ".")
        .map(String::from)
        .collect();
    if comps.is_empty() || comps.len() > 32 || comps.iter().any(|c| !valid_name(c)) {
        return Err(AppError::bad(format!("invalid file path: {rel}")));
    }
    Ok(comps)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn tree(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
) -> AppResult<Json<Vec<Entry>>> {
    require_role(&app, &pid, user.id).await?;
    app.db.call(move |c| Ok(Json(load_tree(c, &pid)?))).await
}

#[derive(Deserialize)]
pub struct CreateReq {
    #[serde(default)]
    parent_id: Option<String>,
    name: String,
    kind: String,
    #[serde(default)]
    content: Option<String>,
}

pub async fn create(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
    Json(req): Json<CreateReq>,
) -> AppResult<Json<Value>> {
    require_editor(&app, &pid, user.id).await?;
    let name = req.name.trim().to_string();
    if !valid_name(&name) {
        return Err(AppError::bad("invalid name"));
    }
    if req.kind != "doc" && req.kind != "folder" {
        return Err(AppError::bad("kind must be 'doc' or 'folder'"));
    }
    let content = normalize_newlines(req.content.unwrap_or_default());
    if content.len() > app.cfg.max_doc_bytes {
        return Err(AppError::bad("document is too large"));
    }
    let parent = norm_parent(req.parent_id);
    let id = new_id();
    let t = now();
    let (p, i, kind) = (pid.clone(), id.clone(), req.kind);
    app.db
        .call(move |c| {
            check_folder(c, &p, parent.as_deref())?;
            if find_child(c, &p, parent.as_deref(), &name)?.is_some() {
                return Err(AppError::conflict(format!("'{name}' already exists here")));
            }
            let (content, size) = if kind == "doc" {
                let n = content.len() as i64;
                (Some(content), n)
            } else {
                (None, 0)
            };
            c.execute(
                "INSERT INTO files (id, project_id, parent_id, name, kind, content, size, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![i, p, parent, name, kind, content, size, t],
            )?;
            touch(c, &p, t)?;
            Ok(())
        })
        .await?;
    app.hub.broadcast(&pid, &json!({ "t": "tree" }));
    Ok(Json(json!({ "id": id })))
}

/// Multipart upload. Fields: optional `parent_id`, then pairs of `path` (relative path,
/// may contain folders) followed by `file`.
pub async fn upload(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
    mut mp: Multipart,
) -> AppResult<Json<Value>> {
    require_editor(&app, &pid, user.id).await?;
    let mut parent: Option<String> = None;
    let mut next_path: Option<String> = None;
    let mut items: Vec<(Vec<String>, FileContent)> = Vec::new();
    let blobs = app.cfg.blobs_dir();
    let max_doc = app.cfg.max_doc_bytes;

    while let Some(field) = mp
        .next_field()
        .await
        .map_err(|e| AppError::bad(format!("upload failed: {e}")))?
    {
        let fname = field.name().unwrap_or("").to_string();
        match fname.as_str() {
            "parent_id" => {
                parent = norm_parent(Some(
                    field
                        .text()
                        .await
                        .map_err(|e| AppError::bad(e.to_string()))?,
                ));
            }
            "path" => {
                next_path = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| AppError::bad(e.to_string()))?,
                );
            }
            "file" => {
                let original = field.file_name().map(str::to_string);
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::bad(format!("upload failed: {e}")))?;
                let rel = next_path
                    .take()
                    .or(original)
                    .ok_or_else(|| AppError::bad("file without a name"))?;
                let comps = split_path(&rel)?;
                let name = comps.last().cloned().unwrap_or_default();
                let b = blobs.clone();
                let content = tokio::task::spawn_blocking(move || {
                    classify(&b, &name, data.to_vec(), max_doc)
                })
                .await??;
                items.push((comps, content));
            }
            _ => {}
        }
    }
    if items.is_empty() {
        return Err(AppError::bad("no files received"));
    }
    if let Some(p) = &parent {
        if !is_valid_id(p) {
            return Err(AppError::bad("invalid parent folder"));
        }
    }

    let p = pid.clone();
    let count = items.len();
    let t = now();
    // (id, previous kind, new text if doc)
    let changed: Vec<(String, Option<String>, Option<String>)> = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            check_folder(&tx, &p, parent.as_deref())?;
            let mut changed = Vec::new();
            for (comps, content) in items {
                let (dirs, name) = comps.split_at(comps.len() - 1);
                let folder = ensure_folders(&tx, &p, parent.clone(), dirs, t)?;
                let (id, prev) = upsert_file(&tx, &p, folder.as_deref(), &name[0], &content, t)?;
                let text = match content {
                    FileContent::Doc(s) => Some(s),
                    FileContent::Blob { .. } => None,
                };
                changed.push((id, prev, text));
            }
            touch(&tx, &p, t)?;
            tx.commit()?;
            Ok(changed)
        })
        .await?;

    // Overwritten documents that may be open in the editor must be refreshed.
    for (id, prev, text) in changed {
        if prev.as_deref() == Some("doc") {
            match text {
                Some(text) => app.hub.reset_doc(&pid, &id, &text),
                None => app.hub.remove_docs(&pid, &[id]),
            }
        }
    }
    app.hub.broadcast(&pid, &json!({ "t": "tree" }));
    Ok(Json(json!({ "uploaded": count })))
}

#[derive(Deserialize)]
pub struct UpdateReq {
    #[serde(default)]
    name: Option<String>,
    /// Target folder id; empty string moves to the root.
    #[serde(default)]
    parent_id: Option<String>,
}

pub async fn update(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, fid)): Path<(String, String)>,
    Json(req): Json<UpdateReq>,
) -> AppResult<Json<Value>> {
    require_editor(&app, &pid, user.id).await?;
    let p = pid.clone();
    let t = now();
    app.db
        .call(move |c| {
            let (cur_parent, cur_name): (Option<String>, String) = c.query_row(
                "SELECT parent_id, name FROM files WHERE id = ?1 AND project_id = ?2",
                params![fid, p],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let new_name = match req.name {
                Some(n) => {
                    let n = n.trim().to_string();
                    if !valid_name(&n) {
                        return Err(AppError::bad("invalid name"));
                    }
                    n
                }
                None => cur_name,
            };
            let new_parent = match req.parent_id {
                Some(target) => {
                    let target = norm_parent(Some(target));
                    if let Some(tg) = &target {
                        check_folder(c, &p, Some(tg))?;
                        // Refuse to move a folder into itself or one of its descendants.
                        let mut cur = Some(tg.clone());
                        let mut guard = 0;
                        while let Some(x) = cur {
                            if x == fid {
                                return Err(AppError::bad("cannot move a folder into itself"));
                            }
                            cur = c.query_row(
                                "SELECT parent_id FROM files WHERE id = ?1",
                                params![x],
                                |r| r.get(0),
                            )?;
                            guard += 1;
                            if guard > 128 {
                                break;
                            }
                        }
                    }
                    target
                }
                None => cur_parent,
            };
            if find_child(c, &p, new_parent.as_deref(), &new_name)?.is_some_and(|(id, _)| id != fid)
            {
                return Err(AppError::conflict(format!(
                    "'{new_name}' already exists in the target folder"
                )));
            }
            c.execute(
                "UPDATE files SET name = ?1, parent_id = ?2, updated_at = ?3 WHERE id = ?4",
                params![new_name, new_parent, t, fid],
            )?;
            touch(c, &p, t)?;
            Ok(())
        })
        .await?;
    app.hub.broadcast(&pid, &json!({ "t": "tree" }));
    Ok(Json(json!({ "ok": true })))
}

pub async fn remove(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, fid)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    require_editor(&app, &pid, user.id).await?;
    let p = pid.clone();
    let t = now();
    let (ids, main_cleared): (Vec<String>, bool) = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let ids = {
                let mut st = tx.prepare(
                    "WITH RECURSIVE sub(id) AS (
                        SELECT id FROM files WHERE id = ?1 AND project_id = ?2
                        UNION ALL
                        SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
                     ) SELECT id FROM sub",
                )?;
                let rows = st.query_map(params![fid, p], |r| r.get::<_, String>(0))?;
                let v = rows.collect::<Result<Vec<_>, _>>()?;
                v
            };
            if ids.is_empty() {
                return Err(AppError::NotFound);
            }
            tx.execute("DELETE FROM files WHERE id = ?1", params![fid])?;
            let main: Option<String> = tx.query_row(
                "SELECT main_file FROM projects WHERE id = ?1",
                params![p],
                |r| r.get(0),
            )?;
            let main_cleared = main.is_some_and(|m| ids.contains(&m));
            if main_cleared {
                tx.execute(
                    "UPDATE projects SET main_file = NULL WHERE id = ?1",
                    params![p],
                )?;
            }
            touch(&tx, &p, t)?;
            tx.commit()?;
            Ok((ids, main_cleared))
        })
        .await?;
    app.hub.remove_docs(&pid, &ids);
    app.hub.broadcast(&pid, &json!({ "t": "tree" }));
    if main_cleared {
        app.hub.broadcast(&pid, &json!({ "t": "project" }));
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn raw(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, fid)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Response> {
    require_role(&app, &pid, user.id).await?;
    let (p, f) = (pid.clone(), fid.clone());
    let (name, kind, content, hash): (String, String, Option<String>, Option<String>) = app
        .db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT name, kind, content, blob_hash FROM files WHERE id = ?1 AND project_id = ?2",
                params![f, p],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .await?;
    let (body, mime) = match kind.as_str() {
        "doc" => {
            let text = app.hub.doc_text(&pid, &fid).or(content).unwrap_or_default();
            (Body::from(text), "text/plain; charset=utf-8".to_string())
        }
        "blob" => {
            let hash = hash.ok_or(AppError::NotFound)?;
            let data = tokio::fs::read(blob_path(&app.cfg.blobs_dir(), &hash))
                .await
                .map_err(|_| AppError::NotFound)?;
            let mime = mime_guess::from_path(&name)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            (Body::from(data), mime)
        }
        _ => return Err(AppError::bad("folders cannot be downloaded")),
    };
    let disposition = if q.contains_key("download") {
        "attachment"
    } else {
        "inline"
    };
    let mut resp = Response::new(body);
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    // User uploaded content must never run scripts on our origin (e.g. SVG/HTML).
    // PDFs are exempt because browsers refuse to render them inside a sandbox.
    if mime != "application/pdf" {
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
            ),
        );
    }
    h.insert(
        header::CONTENT_DISPOSITION,
        content_disposition(disposition, &name),
    );
    Ok(resp)
}
