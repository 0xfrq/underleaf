use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::Connection;

use crate::error::AppResult;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    main_file  TEXT,
    compiler   TEXT NOT NULL DEFAULT 'pdflatex',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id);

CREATE TABLE IF NOT EXISTS members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS files (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES files(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    content    TEXT,
    blob_hash  TEXT,
    size       INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS files_name_uq ON files(project_id, IFNULL(parent_id, ''), name);
CREATE INDEX IF NOT EXISTS files_parent ON files(parent_id);
CREATE INDEX IF NOT EXISTS files_blob ON files(blob_hash);

CREATE TABLE IF NOT EXISTS chat (
    id         INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_project ON chat(project_id, id);

-- Task tracker. Every project can have a board; issues are numbered per project (KEY-1, KEY-2, ...).
CREATE TABLE IF NOT EXISTS boards (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    task_key   TEXT NOT NULL,
    next_num   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sprints (
    id           INTEGER PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    goal         TEXT NOT NULL DEFAULT '',
    state        TEXT NOT NULL DEFAULT 'planned',
    start_date   TEXT,
    end_date     TEXT,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS sprints_project ON sprints(project_id);

CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    num         INTEGER NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'task',
    status      TEXT NOT NULL DEFAULT 'todo',
    priority    TEXT NOT NULL DEFAULT 'medium',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sprint_id   INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
    parent_id   INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    start_date  TEXT,
    due_date    TEXT,
    estimate    INTEGER,
    labels      TEXT NOT NULL DEFAULT '',
    sort_key    REAL NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_num ON tasks(project_id, num);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS tasks_reporter ON tasks(reporter_id);
CREATE INDEX IF NOT EXISTS tasks_sprint ON tasks(sprint_id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS task_comments (
    id         INTEGER PRIMARY KEY,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at  INTEGER
);
CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments(task_id, id);

CREATE TABLE IF NOT EXISTS task_activity (
    id         INTEGER PRIMARY KEY,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    field      TEXT NOT NULL,
    old_value  TEXT,
    new_value  TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_activity_task ON task_activity(task_id, id);
"#;

/// A single SQLite connection guarded by a mutex. All queries are short, so this is
/// plenty for a small instance and keeps memory usage minimal.
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
        conn.execute_batch(
            "PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;
             PRAGMA temp_store=MEMORY;
             PRAGMA cache_size=-16000;",
        )?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Run a closure against the connection on the blocking thread pool.
    pub async fn call<F, R>(&self, f: F) -> AppResult<R>
    where
        F: FnOnce(&mut Connection) -> AppResult<R> + Send + 'static,
        R: Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut guard)
        })
        .await?
    }

    /// Synchronous access, used by the CLI before the runtime serves requests.
    pub fn call_sync<R>(&self, f: impl FnOnce(&mut Connection) -> AppResult<R>) -> AppResult<R> {
        let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }
}
