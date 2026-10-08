mod assets;
mod auth;
mod collab;
mod compile;
mod config;
mod db;
mod error;
mod files;
mod projects;
mod tasks;
mod textops;
mod util;
mod zipio;

use std::{collections::HashSet, fs, sync::Arc, time::Duration};

use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, patch, post},
    Router,
};
use rusqlite::params;
use tower_http::compression::CompressionLayer;
use tracing_subscriber::EnvFilter;

use crate::{collab::Hub, compile::Compiler, config::Config, db::Db, error::AppResult, util::now};

pub struct App {
    pub cfg: Config,
    pub db: Db,
    pub hub: Hub,
    pub compiler: Compiler,
}

pub type Shared = Arc<App>;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("underleaf=info,warn")),
        )
        .init();

    let cfg = Config::from_env();
    fs::create_dir_all(&cfg.data_dir)?;
    fs::create_dir_all(cfg.blobs_dir())?;
    fs::create_dir_all(cfg.compile_dir())?;
    let db = Db::open(&cfg.data_dir.join("underleaf.db"))?;

    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(cmd) = args.first() {
        return cli(cmd, &args[1..], &db);
    }

    let app: Shared = Arc::new(App {
        hub: Hub::new(cfg.max_doc_bytes),
        compiler: Compiler::new(cfg.max_compiles),
        cfg,
        db,
    });

    // Persist edited documents every two seconds.
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(2));
            loop {
                iv.tick().await;
                app.hub.flush(&app.db).await;
            }
        });
    }
    // Hourly housekeeping.
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(3600));
            loop {
                iv.tick().await;
                if let Err(e) = maintenance(&app).await {
                    tracing::warn!("maintenance failed: {e}");
                }
            }
        });
    }

    let listener = tokio::net::TcpListener::bind(&app.cfg.bind).await?;
    tracing::info!("underleaf listening on http://{}", app.cfg.bind);
    let router = build_router(app.clone());
    let shutdown_app = app.clone();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutting down, saving documents");
            shutdown_app.hub.flush(&shutdown_app.db).await;
            // Open websockets would otherwise keep the server alive.
            tokio::spawn(async {
                tokio::time::sleep(Duration::from_secs(3)).await;
                std::process::exit(0);
            });
        })
        .await?;
    app.hub.flush(&app.db).await;
    Ok(())
}

fn build_router(app: Shared) -> Router {
    let upload_limit = app.cfg.max_upload_bytes + 1024 * 1024;
    let api = Router::new()
        .route("/api/config", get(auth::public_config))
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me).patch(auth::update_profile))
        .route("/api/auth/password", post(auth::change_password))
        .route(
            "/api/admin/users",
            get(auth::admin_list_users).post(auth::admin_create_user),
        )
        .route("/api/admin/users/:uid", delete(auth::admin_delete_user))
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/projects/import",
            post(zipio::import).layer(DefaultBodyLimit::max(upload_limit)),
        )
        .route(
            "/api/projects/:pid",
            get(projects::get)
                .patch(projects::update)
                .delete(projects::remove),
        )
        .route("/api/projects/:pid/copy", post(projects::copy))
        .route("/api/projects/:pid/download", get(zipio::export))
        .route("/api/projects/:pid/members", post(projects::add_member))
        .route(
            "/api/projects/:pid/members/:uid",
            delete(projects::remove_member),
        )
        .route("/api/projects/:pid/chat", get(projects::chat_history))
        .route("/api/projects/:pid/tree", get(files::tree))
        .route("/api/projects/:pid/files", post(files::create))
        .route(
            "/api/projects/:pid/upload",
            post(files::upload).layer(DefaultBodyLimit::max(upload_limit)),
        )
        .route(
            "/api/projects/:pid/files/:fid",
            axum::routing::patch(files::update).delete(files::remove),
        )
        .route("/api/projects/:pid/files/:fid/raw", get(files::raw))
        .route("/api/projects/:pid/compile", post(compile::compile))
        .route("/api/projects/:pid/output/:name", get(compile::output))
        .route("/api/projects/:pid/clear-cache", post(compile::clear_cache))
        .route("/api/tasks", get(tasks::mine))
        .route(
            "/api/projects/:pid/tasks",
            get(tasks::board).post(tasks::create_task),
        )
        .route(
            "/api/projects/:pid/tasks/:tid",
            get(tasks::get_task)
                .patch(tasks::update_task)
                .delete(tasks::delete_task),
        )
        .route(
            "/api/projects/:pid/tasks/:tid/comments",
            post(tasks::add_comment),
        )
        .route(
            "/api/projects/:pid/tasks/:tid/comments/:cid",
            patch(tasks::edit_comment).delete(tasks::delete_comment),
        )
        .route("/api/projects/:pid/sprints", post(tasks::create_sprint))
        .route(
            "/api/projects/:pid/sprints/:sid",
            patch(tasks::update_sprint).delete(tasks::delete_sprint),
        )
        .route("/api/projects/:pid/board", patch(tasks::update_board))
        .route("/api/projects/:pid/activity", get(tasks::activity))
        .route("/ws/projects/:pid", get(collab::ws_handler))
        .with_state(app);

    // Everything that is not an API route is a static asset (or the SPA's index.html).
    let statics = Router::new()
        .fallback(assets::serve)
        .layer(CompressionLayer::new());

    api.merge(statics)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}

/// Remove expired sessions and blobs that no file references any more.
async fn maintenance(app: &Shared) -> AppResult<()> {
    let t = now();
    let referenced: HashSet<String> = app
        .db
        .call(move |c| {
            c.execute("DELETE FROM sessions WHERE expires_at <= ?1", params![t])?;
            let mut st =
                c.prepare("SELECT DISTINCT blob_hash FROM files WHERE blob_hash IS NOT NULL")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            let mut set = HashSet::new();
            for r in rows {
                set.insert(r?);
            }
            Ok(set)
        })
        .await?;
    let dir = app.cfg.blobs_dir();
    let removed = tokio::task::spawn_blocking(move || -> std::io::Result<usize> {
        let min_age = Duration::from_secs(3600);
        let mut removed = 0;
        for shard in fs::read_dir(&dir)?.flatten() {
            if !shard.path().is_dir() {
                continue;
            }
            for f in fs::read_dir(shard.path())?.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                let old_enough = f
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| m.elapsed().ok())
                    .is_some_and(|age| age > min_age);
                let unused = name.ends_with(".tmp") || !referenced.contains(&name);
                if old_enough && unused && fs::remove_file(f.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        Ok(removed)
    })
    .await??;
    if removed > 0 {
        tracing::info!("removed {removed} unused blobs");
    }
    Ok(())
}

fn cli(cmd: &str, args: &[String], db: &Db) -> Result<(), BoxError> {
    match cmd {
        "useradd" => {
            if args.len() < 2 {
                eprintln!("usage: underleaf useradd <username> <password> [--admin]");
                std::process::exit(2);
            }
            let admin = args.iter().any(|a| a == "--admin");
            let hash = auth::hash_password_sync(&args[1])?;
            let id = db.call_sync(|c| auth::insert_user(c, &args[0], &args[0], &hash, admin))?;
            println!(
                "created user '{}' (id {id}{})",
                args[0],
                if admin { ", admin" } else { "" }
            );
            Ok(())
        }
        "passwd" => {
            if args.len() < 2 {
                eprintln!("usage: underleaf passwd <username> <new-password>");
                std::process::exit(2);
            }
            let hash = auth::hash_password_sync(&args[1])?;
            let n = db.call_sync(|c| {
                let n = c.execute(
                    "UPDATE users SET password_hash = ?1 WHERE username = ?2",
                    params![hash, args[0]],
                )?;
                c.execute(
                    "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?1)",
                    params![args[0]],
                )?;
                Ok(n)
            })?;
            if n == 0 {
                eprintln!("no such user");
                std::process::exit(1);
            }
            println!("password updated");
            Ok(())
        }
        "promote" => {
            let Some(user) = args.first() else {
                eprintln!("usage: underleaf promote <username>");
                std::process::exit(2);
            };
            db.call_sync(|c| {
                c.execute(
                    "UPDATE users SET is_admin = 1 WHERE username = ?1",
                    params![user],
                )?;
                Ok(())
            })?;
            println!("'{user}' is now an administrator");
            Ok(())
        }
        "help" | "--help" | "-h" => {
            println!(
                "underleaf - collaborative LaTeX editor\n\n\
                 usage:\n  underleaf                      run the server\n  \
                 underleaf useradd <user> <pw> [--admin]\n  \
                 underleaf passwd <user> <pw>\n  \
                 underleaf promote <user>\n\n\
                 configuration is read from UNDERLEAF_* environment variables (see README)"
            );
            Ok(())
        }
        other => {
            eprintln!("unknown command '{other}', try 'underleaf help'");
            std::process::exit(2);
        }
    }
}
