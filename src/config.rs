use std::{env, path::PathBuf};

/// Runtime configuration, read from environment variables (all optional).
#[derive(Clone, Debug)]
pub struct Config {
    /// UNDERLEAF_BIND (default 0.0.0.0:8080)
    pub bind: String,
    /// UNDERLEAF_DATA (default ./data)
    pub data_dir: PathBuf,
    /// UNDERLEAF_ALLOW_SIGNUP (default true). The very first account can always register.
    pub allow_signup: bool,
    /// UNDERLEAF_COOKIE_SECURE (default false). Set to true when served over HTTPS.
    pub cookie_secure: bool,
    /// UNDERLEAF_COMPILE_TIMEOUT seconds (default 90)
    pub compile_timeout: u64,
    /// UNDERLEAF_MAX_COMPILES concurrent compiles (default 2)
    pub max_compiles: usize,
    /// UNDERLEAF_LATEXMK path to latexmk (default "latexmk")
    pub latexmk: String,
    /// UNDERLEAF_COMPILE_WRAPPER e.g. "nice -n 10" or a bwrap/firejail prefix
    pub compile_wrapper: Vec<String>,
    /// UNDERLEAF_USE_TIMEOUT wrap compiles in coreutils `timeout` (default true)
    pub use_timeout_cmd: bool,
    /// UNDERLEAF_MAX_UPLOAD_MB (default 50)
    pub max_upload_bytes: usize,
    /// UNDERLEAF_MAX_DOC_KB maximum size of an editable text document (default 4096)
    pub max_doc_bytes: usize,
    /// UNDERLEAF_SESSION_DAYS (default 30)
    pub session_days: i64,
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn num<T: std::str::FromStr>(name: &str, default: T) -> T {
    var(name)
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

fn flag(name: &str, default: bool) -> bool {
    var(name)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            bind: var("UNDERLEAF_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()),
            data_dir: PathBuf::from(var("UNDERLEAF_DATA").unwrap_or_else(|| "./data".into())),
            allow_signup: flag("UNDERLEAF_ALLOW_SIGNUP", true),
            cookie_secure: flag("UNDERLEAF_COOKIE_SECURE", false),
            compile_timeout: num("UNDERLEAF_COMPILE_TIMEOUT", 90u64).max(5),
            max_compiles: num("UNDERLEAF_MAX_COMPILES", 2usize).max(1),
            latexmk: var("UNDERLEAF_LATEXMK").unwrap_or_else(|| "latexmk".into()),
            compile_wrapper: var("UNDERLEAF_COMPILE_WRAPPER")
                .map(|v| v.split_whitespace().map(String::from).collect())
                .unwrap_or_default(),
            use_timeout_cmd: flag("UNDERLEAF_USE_TIMEOUT", true),
            max_upload_bytes: num("UNDERLEAF_MAX_UPLOAD_MB", 50usize).max(1) * 1024 * 1024,
            max_doc_bytes: num("UNDERLEAF_MAX_DOC_KB", 4096usize).max(64) * 1024,
            session_days: num("UNDERLEAF_SESSION_DAYS", 30i64).max(1),
        }
    }

    pub fn blobs_dir(&self) -> PathBuf {
        self.data_dir.join("blobs")
    }

    pub fn compile_dir(&self) -> PathBuf {
        self.data_dir.join("compile")
    }
}
