use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    async_trait,
    extract::{FromRequestParts, Path, State},
    http::{header, request::Parts, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    error::{AppError, AppResult},
    util::{now, random_hex, sha256_hex},
    Shared,
};

pub const COOKIE_NAME: &str = "ul_session";

#[derive(Clone, Debug, Serialize)]
pub struct AuthUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
}

pub fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(s) = value.to_str() else { continue };
        for part in s.split(';') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix(name).and_then(|r| r.strip_prefix('=')) {
                return Some(v);
            }
        }
    }
    None
}

#[async_trait]
impl FromRequestParts<Shared> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, app: &Shared) -> Result<Self, Self::Rejection> {
        let token = cookie_value(&parts.headers, COOKIE_NAME).ok_or(AppError::Unauthorized)?;
        if token.len() != 64 {
            return Err(AppError::Unauthorized);
        }
        let key = sha256_hex(token.as_bytes());
        let t = now();
        app.db
            .call(move |c| {
                c.query_row(
                    "SELECT u.id, u.username, u.display_name, u.is_admin
                     FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = ?1 AND s.expires_at > ?2",
                    params![key, t],
                    |r| {
                        Ok(AuthUser {
                            id: r.get(0)?,
                            username: r.get(1)?,
                            display_name: r.get(2)?,
                            is_admin: r.get::<_, i64>(3)? != 0,
                        })
                    },
                )
                .optional()?
                .ok_or(AppError::Unauthorized)
            })
            .await
    }
}

// ---------------------------------------------------------------------------
// Password helpers
// ---------------------------------------------------------------------------

pub fn hash_password_sync(pw: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(AppError::internal)
}

async fn hash_password(pw: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || hash_password_sync(&pw)).await?
}

async fn verify_password(pw: String, hash: String) -> AppResult<bool> {
    Ok(tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
            .unwrap_or(false)
    })
    .await?)
}

fn validate_username(u: &str) -> AppResult<()> {
    let ok = (2..=32).contains(&u.len())
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
    if ok {
        Ok(())
    } else {
        Err(AppError::bad(
            "username must be 2-32 characters: letters, digits, '_', '-' or '.'",
        ))
    }
}

fn validate_password(p: &str) -> AppResult<()> {
    if p.len() < 8 || p.len() > 256 {
        return Err(AppError::bad("password must be 8-256 characters"));
    }
    Ok(())
}

fn clean_display_name(d: Option<String>, fallback: &str) -> String {
    let d = d.unwrap_or_default();
    let d: String = d
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    if d.is_empty() {
        fallback.to_string()
    } else {
        d
    }
}

/// Insert a user. Used by registration, the admin API and the CLI.
pub fn insert_user(
    c: &Connection,
    username: &str,
    display_name: &str,
    password_hash: &str,
    is_admin: bool,
) -> AppResult<i64> {
    let exists: Option<i64> = c
        .query_row(
            "SELECT id FROM users WHERE username = ?1",
            params![username],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_some() {
        return Err(AppError::conflict("that username is already taken"));
    }
    c.execute(
        "INSERT INTO users (username, display_name, password_hash, is_admin, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            username,
            display_name,
            password_hash,
            is_admin as i64,
            now()
        ],
    )?;
    Ok(c.last_insert_rowid())
}

fn session_cookie(app: &Shared, token: &str, max_age: i64) -> AppResult<HeaderValue> {
    let secure = if app.cfg.cookie_secure {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
    ))
    .map_err(AppError::internal)
}

async fn start_session(app: &Shared, user: AuthUser) -> AppResult<Response> {
    let token = random_hex(32);
    let key = sha256_hex(token.as_bytes());
    let max_age = app.cfg.session_days * 86_400;
    let expires = now() + max_age;
    let uid = user.id;
    app.db
        .call(move |c| {
            c.execute(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)",
                params![key, uid, expires],
            )?;
            Ok(())
        })
        .await?;
    let mut resp = Json(user).into_response();
    resp.headers_mut()
        .insert(header::SET_COOKIE, session_cookie(app, &token, max_age)?);
    Ok(resp)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn public_config(State(app): State<Shared>) -> AppResult<Json<Value>> {
    let allow = app.cfg.allow_signup;
    let has_users = app
        .db
        .call(|c| {
            Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM users)", [], |r| {
                r.get::<_, bool>(0)
            })?)
        })
        .await?;
    Ok(Json(json!({ "allow_signup": allow || !has_users })))
}

#[derive(Deserialize)]
pub struct RegisterReq {
    username: String,
    password: String,
    #[serde(default)]
    display_name: Option<String>,
}

pub async fn register(
    State(app): State<Shared>,
    Json(req): Json<RegisterReq>,
) -> AppResult<Response> {
    let username = req.username.trim().to_string();
    validate_username(&username)?;
    validate_password(&req.password)?;
    let display = clean_display_name(req.display_name, &username);
    let allow = app.cfg.allow_signup;
    let hash = hash_password(req.password).await?;
    let user = app
        .db
        .call(move |c| {
            let count: i64 = c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
            if count > 0 && !allow {
                return Err(AppError::forbidden(
                    "registration is disabled on this server",
                ));
            }
            let is_admin = count == 0;
            let id = insert_user(c, &username, &display, &hash, is_admin)?;
            Ok(AuthUser {
                id,
                username,
                display_name: display,
                is_admin,
            })
        })
        .await?;
    start_session(&app, user).await
}

#[derive(Deserialize)]
pub struct LoginReq {
    username: String,
    password: String,
}

pub async fn login(State(app): State<Shared>, Json(req): Json<LoginReq>) -> AppResult<Response> {
    let username = req.username.trim().to_string();
    let row = app
        .db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT id, username, display_name, is_admin, password_hash FROM users WHERE username = ?1",
                params![username],
                |r| {
                    Ok((
                        AuthUser {
                            id: r.get(0)?,
                            username: r.get(1)?,
                            display_name: r.get(2)?,
                            is_admin: r.get::<_, i64>(3)? != 0,
                        },
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?)
        })
        .await?;
    let invalid = || AppError::bad("invalid username or password");
    let Some((user, hash)) = row else {
        // Spend comparable time so usernames cannot be probed by timing.
        let _ = hash_password(req.password).await;
        return Err(invalid());
    };
    if !verify_password(req.password, hash).await? {
        return Err(invalid());
    }
    start_session(&app, user).await
}

pub async fn logout(State(app): State<Shared>, headers: HeaderMap) -> AppResult<Response> {
    if let Some(token) = cookie_value(&headers, COOKIE_NAME) {
        let key = sha256_hex(token.as_bytes());
        app.db
            .call(move |c| {
                c.execute("DELETE FROM sessions WHERE token = ?1", params![key])?;
                Ok(())
            })
            .await?;
    }
    let mut resp = Json(json!({ "ok": true })).into_response();
    resp.headers_mut()
        .insert(header::SET_COOKIE, session_cookie(&app, "", 0)?);
    Ok(resp)
}

pub async fn me(user: AuthUser) -> Json<AuthUser> {
    Json(user)
}

#[derive(Deserialize)]
pub struct PasswordReq {
    old_password: String,
    new_password: String,
}

pub async fn change_password(
    State(app): State<Shared>,
    headers: HeaderMap,
    user: AuthUser,
    Json(req): Json<PasswordReq>,
) -> AppResult<Json<Value>> {
    validate_password(&req.new_password)?;
    let uid = user.id;
    let current: String = app
        .db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT password_hash FROM users WHERE id = ?1",
                params![uid],
                |r| r.get(0),
            )?)
        })
        .await?;
    if !verify_password(req.old_password, current).await? {
        return Err(AppError::bad("current password is incorrect"));
    }
    let hash = hash_password(req.new_password).await?;
    let keep = cookie_value(&headers, COOKIE_NAME)
        .map(|t| sha256_hex(t.as_bytes()))
        .unwrap_or_default();
    app.db
        .call(move |c| {
            c.execute(
                "UPDATE users SET password_hash = ?1 WHERE id = ?2",
                params![hash, uid],
            )?;
            c.execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND token != ?2",
                params![uid, keep],
            )?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ProfileReq {
    display_name: String,
}

pub async fn update_profile(
    State(app): State<Shared>,
    user: AuthUser,
    Json(req): Json<ProfileReq>,
) -> AppResult<Json<Value>> {
    let name = clean_display_name(Some(req.display_name), &user.username);
    let uid = user.id;
    let n = name.clone();
    app.db
        .call(move |c| {
            c.execute(
                "UPDATE users SET display_name = ?1 WHERE id = ?2",
                params![n, uid],
            )?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "display_name": name })))
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

fn require_admin(user: &AuthUser) -> AppResult<()> {
    if user.is_admin {
        Ok(())
    } else {
        Err(AppError::forbidden("administrator access required"))
    }
}

pub async fn admin_list_users(State(app): State<Shared>, user: AuthUser) -> AppResult<Json<Value>> {
    require_admin(&user)?;
    app.db
        .call(|c| {
            let mut st = c.prepare(
                "SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at,
                        (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id)
                 FROM users u ORDER BY u.id",
            )?;
            let rows = st.query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "username": r.get::<_, String>(1)?,
                    "display_name": r.get::<_, String>(2)?,
                    "is_admin": r.get::<_, i64>(3)? != 0,
                    "created_at": r.get::<_, i64>(4)?,
                    "projects": r.get::<_, i64>(5)?,
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
pub struct AdminCreateReq {
    username: String,
    password: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    is_admin: bool,
}

pub async fn admin_create_user(
    State(app): State<Shared>,
    user: AuthUser,
    Json(req): Json<AdminCreateReq>,
) -> AppResult<Json<Value>> {
    require_admin(&user)?;
    let username = req.username.trim().to_string();
    validate_username(&username)?;
    validate_password(&req.password)?;
    let display = clean_display_name(req.display_name, &username);
    let hash = hash_password(req.password).await?;
    let is_admin = req.is_admin;
    let id = app
        .db
        .call(move |c| insert_user(c, &username, &display, &hash, is_admin))
        .await?;
    Ok(Json(json!({ "id": id })))
}

pub async fn admin_delete_user(
    State(app): State<Shared>,
    user: AuthUser,
    Path(uid): Path<i64>,
) -> AppResult<Json<Value>> {
    require_admin(&user)?;
    if uid == user.id {
        return Err(AppError::bad("you cannot delete your own account"));
    }
    let owned: Vec<String> = app
        .db
        .call(move |c| {
            let ids = {
                let mut st = c.prepare("SELECT id FROM projects WHERE owner_id = ?1")?;
                let rows = st.query_map(params![uid], |r| r.get::<_, String>(0))?;
                let v = rows.collect::<Result<Vec<_>, _>>()?;
                v
            };
            let n = c.execute("DELETE FROM users WHERE id = ?1", params![uid])?;
            if n == 0 {
                return Err(AppError::NotFound);
            }
            Ok(ids)
        })
        .await?;
    for pid in owned {
        app.hub.drop_project(&pid);
        let _ = tokio::fs::remove_dir_all(app.cfg.compile_dir().join(&pid)).await;
    }
    Ok(Json(json!({ "ok": true })))
}
