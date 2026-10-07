//! Project import from / export to .zip archives.

use std::{
    io::{Cursor, Read, Write},
    path::{Component, Path as FsPath},
};

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::header,
    response::Response,
    Json,
};
use rusqlite::params;
use serde_json::{json, Value};

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    files::{
        blob_path, build_paths, classify, ensure_folders, load_full, upsert_file, FileContent,
    },
    projects::require_role,
    util::{content_disposition, new_id, now, valid_name},
    Shared,
};

const MAX_ENTRIES: usize = 10_000;
const MAX_ENTRY_BYTES: u64 = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;

pub async fn export(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
) -> AppResult<Response> {
    require_role(&app, &pid, user.id).await?;
    let live = app.hub.live_texts(&pid);
    let p = pid.clone();
    let (name, rows) = app
        .db
        .call(move |c| {
            let name: String =
                c.query_row("SELECT name FROM projects WHERE id = ?1", params![p], |r| {
                    r.get(0)
                })?;
            Ok((name, load_full(c, &p)?))
        })
        .await?;
    let blobs = app.cfg.blobs_dir();

    let bytes = tokio::task::spawn_blocking(move || -> AppResult<Vec<u8>> {
        let paths = build_paths(
            rows.iter()
                .map(|r| (r.id.as_str(), r.parent_id.as_deref(), r.name.as_str())),
        );
        let mut entries: Vec<(&String, &crate::files::FullRow)> = rows
            .iter()
            .filter_map(|r| paths.get(&r.id).map(|p| (p, r)))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));

        let mut zw = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let deflate = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (path, r) in entries {
            match r.kind.as_str() {
                "folder" => {
                    zw.add_directory(format!("{path}/"), deflate)?;
                }
                "doc" => {
                    let text = live
                        .get(&r.id)
                        .map(String::as_str)
                        .or(r.content.as_deref())
                        .unwrap_or("");
                    zw.start_file(path.as_str(), deflate)?;
                    zw.write_all(text.as_bytes())?;
                }
                "blob" => {
                    let Some(h) = &r.blob_hash else { continue };
                    let data = std::fs::read(blob_path(&blobs, h))?;
                    zw.start_file(path.as_str(), stored)?;
                    zw.write_all(&data)?;
                }
                _ => {}
            }
        }
        Ok(zw.finish()?.into_inner())
    })
    .await??;

    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.trim().is_empty() {
        "project".to_string()
    } else {
        safe.trim().to_string()
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            content_disposition("attachment", &format!("{safe}.zip")),
        )
        .body(Body::from(bytes))
        .map_err(AppError::internal)
}

/// Read a zip archive into (path components, content) pairs, storing binaries as blobs.
fn read_zip(
    data: &[u8],
    blobs: &FsPath,
    max_doc: usize,
) -> AppResult<Vec<(Vec<String>, FileContent)>> {
    let mut ar = zip::ZipArchive::new(Cursor::new(data))?;
    if ar.len() > MAX_ENTRIES {
        return Err(AppError::bad("zip has too many entries"));
    }
    let mut raw: Vec<(Vec<String>, Vec<u8>)> = Vec::new();
    let mut total: u64 = 0;
    for i in 0..ar.len() {
        let mut f = ar.by_index(i)?;
        if f.is_dir() {
            continue;
        }
        let Some(path) = f.enclosed_name() else {
            continue;
        };
        let comps: Vec<String> = path
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        if comps.is_empty()
            || comps
                .iter()
                .any(|c| c == "__MACOSX" || c == ".DS_Store" || c == "Thumbs.db")
            || comps.iter().any(|c| !valid_name(c))
        {
            continue;
        }
        let mut buf = Vec::new();
        (&mut f).take(MAX_ENTRY_BYTES + 1).read_to_end(&mut buf)?;
        if buf.len() as u64 > MAX_ENTRY_BYTES {
            return Err(AppError::bad("a file in the zip is too large"));
        }
        total += buf.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(AppError::bad("zip content is too large"));
        }
        raw.push((comps, buf));
    }

    // Archives made by zipping a folder have a single top-level directory: strip it.
    if !raw.is_empty() && raw.iter().all(|(c, _)| c.len() > 1) {
        let first = raw[0].0[0].clone();
        if raw.iter().all(|(c, _)| c[0] == first) {
            for (c, _) in raw.iter_mut() {
                c.remove(0);
            }
        }
    }

    let mut out = Vec::with_capacity(raw.len());
    for (comps, data) in raw {
        let name = comps.last().cloned().unwrap_or_default();
        let content = classify(blobs, &name, data, max_doc)?;
        out.push((comps, content));
    }
    Ok(out)
}

pub async fn import(
    State(app): State<Shared>,
    user: AuthUser,
    mut mp: Multipart,
) -> AppResult<Json<Value>> {
    let mut data: Option<Vec<u8>> = None;
    let mut name: Option<String> = None;
    while let Some(field) = mp
        .next_field()
        .await
        .map_err(|e| AppError::bad(format!("upload failed: {e}")))?
    {
        let field_name = field.name().unwrap_or("").to_string();
        match field_name.as_str() {
            "file" => {
                if name.is_none() {
                    name = field.file_name().map(|n| {
                        n.trim_end_matches(".zip")
                            .trim_end_matches(".ZIP")
                            .to_string()
                    });
                }
                data = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| AppError::bad(format!("upload failed: {e}")))?
                        .to_vec(),
                );
            }
            "name" => {
                let n = field
                    .text()
                    .await
                    .map_err(|e| AppError::bad(e.to_string()))?;
                if !n.trim().is_empty() {
                    name = Some(n);
                }
            }
            _ => {}
        }
    }
    let data = data.ok_or_else(|| AppError::bad("no zip file received"))?;
    let name: String = name
        .unwrap_or_else(|| "Imported project".into())
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(150)
        .collect();
    let name = if name.is_empty() {
        "Imported project".to_string()
    } else {
        name
    };

    let blobs = app.cfg.blobs_dir();
    let max_doc = app.cfg.max_doc_bytes;
    let entries = tokio::task::spawn_blocking(move || read_zip(&data, &blobs, max_doc)).await??;
    if entries.is_empty() {
        return Err(AppError::bad("the zip file contains no usable files"));
    }

    let pid = new_id();
    let p = pid.clone();
    let uid = user.id;
    app.db
        .call(move |c| {
            let t = now();
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO projects (id, name, owner_id, main_file, compiler, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, 'pdflatex', ?4, ?4)",
                params![p, name, uid, t],
            )?;
            let mut main: Option<String> = None;
            let mut fallback: Option<String> = None;
            let mut fallback_is_root = false;
            let mut uses_fontspec = false;
            for (comps, content) in &entries {
                let (dirs, file) = comps.split_at(comps.len() - 1);
                let folder = ensure_folders(&tx, &p, None, dirs, t)?;
                let (id, _) = upsert_file(&tx, &p, folder.as_deref(), &file[0], content, t)?;
                if let FileContent::Doc(text) = content {
                    let is_tex = file[0].to_ascii_lowercase().ends_with(".tex");
                    if is_tex && text.contains("\\documentclass") {
                        if dirs.is_empty() && file[0] == "main.tex" {
                            main = Some(id.clone());
                        } else if fallback.is_none() || (dirs.is_empty() && !fallback_is_root) {
                            fallback = Some(id.clone());
                            fallback_is_root = dirs.is_empty();
                        }
                        uses_fontspec |= text.contains("{fontspec}");
                    }
                }
            }
            let main = main.or(fallback);
            let compiler = if uses_fontspec { "xelatex" } else { "pdflatex" };
            tx.execute(
                "UPDATE projects SET main_file = ?1, compiler = ?2 WHERE id = ?3",
                params![main, compiler, p],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "id": pid })))
}
