//! The frontend (web/static) is embedded into the binary at build time.

use axum::{
    body::Body,
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use rust_embed::RustEmbed;
use serde_json::json;

#[derive(RustEmbed)]
#[folder = "web/static/"]
struct Assets;

pub async fn serve(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path.starts_with("ws/") {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    }
    // Unknown paths fall back to index.html so client-side routes work on reload.
    let (path, file) = match (!path.is_empty()).then(|| Assets::get(path)).flatten() {
        Some(f) => (path, f),
        None => match Assets::get("index.html") {
            Some(f) => ("index.html", f),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    "frontend not built: run `npm run build` in web/ before `cargo build`",
                )
                    .into_response()
            }
        },
    };
    let etag = format!("\"{}\"", hex::encode(&file.metadata.sha256_hash()[..12]));
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == etag)
    {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .body(Body::empty())
            .unwrap_or_default();
    }
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::ETAG, etag)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header("referrer-policy", "same-origin")
        .body(Body::from(file.data))
        .unwrap_or_default()
}
