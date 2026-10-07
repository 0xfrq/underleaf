//! LaTeX compilation via latexmk.
//!
//! Every project has a persistent working directory (data/compile/<project>) so
//! latexmk can reuse aux files between runs; only changed files are rewritten.
//! Compiles are serialized per project and limited globally by a semaphore.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::header,
    response::Response,
    Json,
};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{process::Command, sync::Semaphore};

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    files::{blob_path, build_paths, load_full},
    projects::{require_editor, require_role},
    util::{now_ms, sha256_hex, tail, MANIFEST_NAME},
    Shared,
};

pub struct Compiler {
    sem: Semaphore,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Compiler {
    pub fn new(max_parallel: usize) -> Self {
        Compiler {
            sem: Semaphore::new(max_parallel),
            locks: Mutex::new(HashMap::new()),
        }
    }

    fn lock_for(&self, pid: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 4096 {
            map.retain(|_, l| Arc::strong_count(l) > 1);
        }
        map.entry(pid.to_string()).or_default().clone()
    }
}

#[derive(Serialize)]
pub struct LogEntry {
    level: &'static str,
    file: Option<String>,
    line: Option<u32>,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<String>,
}

#[derive(Serialize)]
pub struct CompileResult {
    status: &'static str,
    pdf: Option<String>,
    main: Option<String>,
    entries: Vec<LogEntry>,
    log: String,
    stdout: String,
    duration_ms: u64,
}

impl CompileResult {
    fn failure(msg: String) -> Self {
        CompileResult {
            status: "failure",
            pdf: None,
            main: None,
            entries: vec![LogEntry {
                level: "error",
                file: None,
                line: None,
                message: msg.clone(),
                context: None,
            }],
            log: msg,
            stdout: String::new(),
            duration_ms: 0,
        }
    }
}

enum Src {
    Text(String),
    Blob(String),
}

/// Mirror the project into `dir`, rewriting only files whose content changed.
fn sync_dir(
    dir: &FsPath,
    folders: &[String],
    files: Vec<(String, Src)>,
    blobs: &FsPath,
) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let manifest_path = dir.join(MANIFEST_NAME);
    let old: HashMap<String, String> = fs::read(&manifest_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut new: HashMap<String, String> = HashMap::with_capacity(files.len());
    let safe = |p: &str| {
        !p.split('/')
            .any(|c| c.is_empty() || c == ".." || c == "." || c == MANIFEST_NAME)
    };

    for f in folders {
        if safe(f.as_str()) {
            let target = dir.join(f);
            if target.is_file() {
                fs::remove_file(&target)?;
            }
            fs::create_dir_all(target)?;
        }
    }
    for (path, src) in files {
        if !safe(path.as_str()) {
            continue;
        }
        let target = dir.join(&path);
        let hash = match &src {
            Src::Text(t) => sha256_hex(t.as_bytes()),
            Src::Blob(h) => h.clone(),
        };
        if old.get(&path) != Some(&hash) || !target.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            if target.is_dir() {
                fs::remove_dir_all(&target)?;
            }
            match &src {
                Src::Text(t) => fs::write(&target, t)?,
                Src::Blob(h) => {
                    fs::copy(blob_path(blobs, h), &target)?;
                }
            }
        }
        new.insert(path, hash);
    }
    for path in old.keys() {
        if !new.contains_key(path) && safe(path.as_str()) {
            let _ = fs::remove_file(dir.join(path));
        }
    }
    fs::write(&manifest_path, serde_json::to_vec(&new)?)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/// Parse `./file.tex:12: message` (produced by -file-line-error).
fn file_line_error(line: &str) -> Option<(&str, u32, &str)> {
    let mut search = 0;
    while let Some(off) = line[search..].find(':') {
        let p = search + off;
        let after = &line[p + 1..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if p > 0 && digits > 0 && after[digits..].starts_with(": ") {
            let file = &line[..p];
            if file.contains('.') && !file.starts_with(' ') {
                let ln = after[..digits].parse().ok()?;
                return Some((file, ln, &after[digits + 2..]));
            }
        }
        search = p + 1;
    }
    None
}

fn looks_like_file(name: &str) -> bool {
    if name.is_empty() || name.len() > 400 {
        return false;
    }
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty()
                && !ext.is_empty()
                && ext.len() <= 8
                && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// Track which file TeX is reading, using the "(./file.tex ... )" nesting in the log.
fn track_files(line: &str, stack: &mut Vec<String>) {
    let b = line.as_bytes();
    let mut k = 0;
    while k < b.len() {
        match b[k] {
            b'(' => {
                let rest = &line[k + 1..];
                let end = rest
                    .find(|c: char| c.is_whitespace() || c == '(' || c == ')')
                    .unwrap_or(rest.len());
                let name = &rest[..end];
                if looks_like_file(name) {
                    stack.push(name.to_string());
                    k += 1 + end;
                    continue;
                }
                stack.push(String::new());
            }
            b')' => {
                stack.pop();
            }
            _ => {}
        }
        k += 1;
    }
}

fn current_file(stack: &[String]) -> Option<String> {
    stack
        .iter()
        .rev()
        .find(|s| !s.is_empty())
        .and_then(|s| clean_path(s))
}

/// Project-relative path, or None for system files (absolute paths).
fn clean_path(p: &str) -> Option<String> {
    if p.starts_with('/') {
        return None;
    }
    Some(p.trim_start_matches("./").to_string())
}

fn number_after(s: &str, marker: &str) -> Option<u32> {
    let i = s.find(marker)? + marker.len();
    let digits: String = s[i..].chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn l_line(lines: &[&str], from: usize) -> Option<u32> {
    lines
        .iter()
        .skip(from + 1)
        .take(12)
        .find_map(|l| l.strip_prefix("l.").and_then(|r| number_after(r, "")))
}

fn context(lines: &[&str], from: usize) -> Option<String> {
    let mut out = Vec::new();
    for l in lines.iter().skip(from + 1).take(10) {
        out.push(*l);
        if l.starts_with("l.") {
            break;
        }
    }
    let s = out.join("\n").trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn is_warning(line: &str) -> bool {
    line.starts_with("LaTeX Warning:")
        || line.starts_with("LaTeX Font Warning:")
        || ((line.starts_with("Package ") || line.starts_with("Class "))
            && line.contains(" Warning:"))
        || line.starts_with("pdfTeX warning")
}

pub fn parse_log(log: &str) -> Vec<LogEntry> {
    let lines: Vec<&str> = log.lines().collect();
    let mut out: Vec<LogEntry> = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    for (i, &line) in lines.iter().enumerate() {
        if out.len() >= 500 {
            break;
        }
        if let Some((file, ln, msg)) = file_line_error(line) {
            out.push(LogEntry {
                level: "error",
                file: clean_path(file),
                line: Some(ln),
                message: msg.to_string(),
                context: context(&lines, i),
            });
        } else if let Some(rest) = line.strip_prefix("! ") {
            out.push(LogEntry {
                level: "error",
                file: current_file(&stack),
                line: l_line(&lines, i),
                message: rest.to_string(),
                context: context(&lines, i),
            });
        } else if is_warning(line) {
            let mut msg = line.to_string();
            for next in lines.iter().skip(i + 1).take(6) {
                let t = next.trim_start();
                // Package warnings continue on lines like "(hyperref)    more text".
                let cont = t.starts_with('(')
                    && t.find(')')
                        .is_some_and(|p| p < 30 && t[p + 1..].starts_with("  "));
                if !cont {
                    break;
                }
                msg.push(' ');
                msg.push_str(t[t.find(')').unwrap_or(0) + 1..].trim());
            }
            let line_no = number_after(&msg, "on input line ");
            out.push(LogEntry {
                level: "warning",
                file: current_file(&stack),
                line: line_no,
                message: msg,
                context: None,
            });
        } else if line.starts_with("Overfull \\") || line.starts_with("Underfull \\") {
            let ln = number_after(line, "at lines ").or_else(|| number_after(line, "at line "));
            out.push(LogEntry {
                level: "typesetting",
                file: current_file(&stack),
                line: ln,
                message: line.to_string(),
                context: None,
            });
        }
        track_files(line, &mut stack);
    }
    // Drop exact duplicates (TeX repeats some messages on every run).
    let mut seen = std::collections::HashSet::new();
    out.retain(|e| seen.insert((e.level, e.file.clone(), e.line, e.message.clone())));
    out
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn compile(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
) -> AppResult<Json<CompileResult>> {
    require_role(&app, &pid, user.id).await?;
    let lock = app.compiler.lock_for(&pid);
    let _guard = lock.lock().await;
    let _permit = app
        .compiler
        .sem
        .acquire()
        .await
        .map_err(AppError::internal)?;
    let started = Instant::now();
    let start_time = SystemTime::now();

    // In-memory documents are newer than the database copy.
    let live = app.hub.live_texts(&pid);
    let p = pid.clone();
    let (main_file, compiler, rows) = app
        .db
        .call(move |c| {
            let (main_file, compiler): (Option<String>, String) = c.query_row(
                "SELECT main_file, compiler FROM projects WHERE id = ?1",
                params![p],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            Ok((main_file, compiler, load_full(c, &p)?))
        })
        .await?;

    let paths = build_paths(
        rows.iter()
            .map(|r| (r.id.as_str(), r.parent_id.as_deref(), r.name.as_str())),
    );
    let main_path = main_file
        .as_ref()
        .and_then(|id| paths.get(id))
        .filter(|p| p.to_ascii_lowercase().ends_with(".tex"))
        .cloned();

    let mut folders = Vec::new();
    let mut items: Vec<(String, Src)> = Vec::new();
    for r in rows {
        let Some(path) = paths.get(&r.id) else {
            continue;
        };
        match r.kind.as_str() {
            "folder" => folders.push(path.clone()),
            "doc" => {
                let text = live.get(&r.id).cloned().or(r.content).unwrap_or_default();
                items.push((path.clone(), Src::Text(text)));
            }
            "blob" => {
                if let Some(h) = r.blob_hash {
                    items.push((path.clone(), Src::Blob(h)));
                }
            }
            _ => {}
        }
    }

    let main_path = main_path
        .or_else(|| {
            items
                .iter()
                .find(|(p, _)| p == "main.tex")
                .map(|(p, _)| p.clone())
        })
        .or_else(|| {
            items
                .iter()
                .find(|(p, s)| {
                    p.ends_with(".tex")
                        && matches!(s, Src::Text(t) if t.contains("\\documentclass"))
                })
                .map(|(p, _)| p.clone())
        });
    let Some(main_path) = main_path else {
        return Ok(Json(CompileResult::failure(
            "No main document found. Create a .tex file containing \\documentclass or choose one in the project settings.".into(),
        )));
    };

    let dir = app.cfg.compile_dir().join(&pid);
    let blobs = app.cfg.blobs_dir();
    {
        let dir = dir.clone();
        tokio::task::spawn_blocking(move || sync_dir(&dir, &folders, items, &blobs)).await??;
    }

    let secs = app.cfg.compile_timeout;
    let engine = match compiler.as_str() {
        "xelatex" => "-pdfxe",
        "lualatex" => "-pdflua",
        _ => "-pdf",
    };
    let mut argv: Vec<String> = Vec::new();
    if app.cfg.use_timeout_cmd {
        argv.extend(["timeout".into(), "-k".into(), "5".into(), secs.to_string()]);
    }
    argv.extend(app.cfg.compile_wrapper.iter().cloned());
    argv.push(app.cfg.latexmk.clone());
    argv.extend(
        [
            "-norc",
            "-f",
            engine,
            "-interaction=nonstopmode",
            "-file-line-error",
            "-synctex=1",
            "-jobname=output",
        ]
        .map(String::from),
    );
    argv.push(main_path.clone());

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(&dir)
        // Hardening via kpathsea: no \write18, no reading/writing outside the project.
        .env("shell_escape", "f")
        .env("openout_any", "p")
        .env("openin_any", "p")
        // Long log lines make the log parser far more reliable.
        .env("max_print_line", "10000")
        .env("error_line", "254")
        .env("half_error_line", "238")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let run = tokio::time::timeout(Duration::from_secs(secs + 15), cmd.output()).await;
    let (status, stdout): (&'static str, String) = match run {
        Err(_) => ("timeout", String::new()),
        Ok(Err(e)) => {
            return Ok(Json(CompileResult::failure(format!(
                "Could not start '{}': {e}. Is TeX Live (with latexmk) installed?",
                argv[0]
            ))))
        }
        Ok(Ok(out)) => {
            let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
            s.push_str(&String::from_utf8_lossy(&out.stderr));
            let st = match out.status.code() {
                Some(0) => "success",
                Some(124) | Some(137) | None if app.cfg.use_timeout_cmd => "timeout",
                _ => "error",
            };
            (st, s)
        }
    };

    let pdf_path = dir.join("output.pdf");
    let pdf_ok = match tokio::fs::metadata(&pdf_path).await {
        Ok(m) => {
            status == "success"
                || m.modified()
                    .map(|t| t + Duration::from_secs(2) >= start_time)
                    .unwrap_or(false)
        }
        Err(_) => false,
    };
    let status = if status == "success" && !pdf_ok {
        "failure"
    } else {
        status
    };
    let log_bytes = tokio::fs::read(dir.join("output.log"))
        .await
        .unwrap_or_default();
    let log = String::from_utf8_lossy(&log_bytes);
    let entries = parse_log(&log);

    Ok(Json(CompileResult {
        status,
        pdf: pdf_ok.then(|| format!("/api/projects/{pid}/output/output.pdf?v={}", now_ms())),
        main: Some(main_path),
        entries,
        log: tail(&log, 512 * 1024),
        stdout: tail(&stdout, 64 * 1024),
        duration_ms: started.elapsed().as_millis() as u64,
    }))
}

pub async fn output(
    State(app): State<Shared>,
    user: AuthUser,
    Path((pid, name)): Path<(String, String)>,
) -> AppResult<Response> {
    require_role(&app, &pid, user.id).await?;
    let mime = match name.as_str() {
        "output.pdf" => "application/pdf",
        "output.log" => "text/plain; charset=utf-8",
        "output.synctex.gz" => "application/gzip",
        _ => return Err(AppError::NotFound),
    };
    // Wait for a running compile so we never serve a half-written PDF.
    let lock = app.compiler.lock_for(&pid);
    let _guard = lock.lock().await;
    let path: PathBuf = app.cfg.compile_dir().join(&pid).join(&name);
    let data = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::NotFound)?;
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(data))
        .map_err(AppError::internal)
}

pub async fn clear_cache(
    State(app): State<Shared>,
    user: AuthUser,
    Path(pid): Path<String>,
) -> AppResult<Json<Value>> {
    require_editor(&app, &pid, user.id).await?;
    let lock = app.compiler.lock_for(&pid);
    let _guard = lock.lock().await;
    let dir = app.cfg.compile_dir().join(&pid);
    if tokio::fs::metadata(&dir).await.is_ok() {
        tokio::fs::remove_dir_all(&dir).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_file_line_errors() {
        let log = "(./main.tex\n./main.tex:12: Undefined control sequence.\nl.12 \\foo\n)";
        let e = parse_log(log);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].file.as_deref(), Some("main.tex"));
        assert_eq!(e[0].line, Some(12));
    }

    #[test]
    fn attributes_warnings_to_files() {
        let log = "(./main.tex (./chapters/intro.tex\nLaTeX Warning: Reference `x' on page 1 undefined on input line 7.\n))";
        let e = parse_log(log);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].level, "warning");
        assert_eq!(e[0].file.as_deref(), Some("chapters/intro.tex"));
        assert_eq!(e[0].line, Some(7));
    }

    #[test]
    fn boxes() {
        let log = "(./a.tex\nOverfull \\hbox (1.0pt too wide) in paragraph at lines 3--4\n)";
        let e = parse_log(log);
        assert_eq!(e[0].level, "typesetting");
        assert_eq!(e[0].line, Some(3));
    }
}
