# Underleaf

A lightweight, self-hosted, Overleaf-style collaborative LaTeX editor.
It's one Rust binary with the web UI embedded. Idle memory use is a few MB, and the database is SQLite.

* **LaTeX editor**: CodeMirror 6 with LaTeX highlighting, autocompletion of commands, environments,
  `\ref` labels and `\cite` keys from your `.bib` files, search and replace, and bracket matching.
* **Live collaboration** works like Google Docs: concurrent editing, colored remote cursors with names,
  an online-users list, and project chat. You see who is in which file.
* **Compilation**: pdfLaTeX, XeLaTeX or LuaLaTeX through `latexmk`. Builds are incremental and keep aux files
  between runs. Ctrl+S / Ctrl+Enter recompiles, with optional auto-compile. Errors and warnings are parsed
  from the log, and clicking one jumps to the file and line.
* **Files and folders**: create, rename, move by drag and drop, and delete. You can upload files, whole folders,
  or drag them in from your OS. Images and PDFs preview in place. You can set the main document.
* **Projects**: create from templates (article, report, beamer, blank), import or export a `.zip`, copy,
  and share with other users as *editor* or *viewer*.
* **Accounts**: username and password (argon2), optional open sign-up, and an admin user panel.

## Building (in WSL / Linux)

Requirements: Rust (stable, 1.75+), Node.js 18+ (only to bundle the frontend once).

```bash
bash build.sh
# or manually:
cd web && npm install && npm run build && cd ..
cargo build --release
```

The frontend must be built **before** `cargo build`, because `web/static/` is embedded into the binary.
The result is `target/release/underleaf`. Copy that single file to your server; Node.js is not needed there.

Run the unit tests (text-change application, log parser, helpers) with `cargo test`.

## Running

The server needs TeX Live with `latexmk`. On Debian/Ubuntu, a reasonably small set is:

```bash
sudo apt install latexmk texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
     texlive-science texlive-pictures texlive-bibtex-extra biber texlive-xetex texlive-luatex lmodern
```

(`texlive-full` works too, but it is several GB.)

```bash
./underleaf                 # listens on 0.0.0.0:8080, stores data in ./data
```

Open the site. **The first account that registers becomes the administrator.** After that, set
`UNDERLEAF_ALLOW_SIGNUP=false` if you don't want strangers to sign up. Admins can create users in the UI
(user menu → Manage users) or on the command line:

```bash
underleaf useradd alice 'a-long-password' [--admin]
underleaf passwd alice 'new-password'
underleaf promote alice
```

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `UNDERLEAF_BIND` | `0.0.0.0:8080` | listen address |
| `UNDERLEAF_DATA` | `./data` | database, uploaded files, build cache |
| `UNDERLEAF_ALLOW_SIGNUP` | `true` | allow self-registration (the first user can always register) |
| `UNDERLEAF_COOKIE_SECURE` | `false` | set `true` when served over HTTPS |
| `UNDERLEAF_COMPILE_TIMEOUT` | `90` | seconds per compile |
| `UNDERLEAF_MAX_COMPILES` | `2` | concurrent compiles (protects a small VPS) |
| `UNDERLEAF_LATEXMK` | `latexmk` | path to latexmk |
| `UNDERLEAF_COMPILE_WRAPPER` | – | command prefix for compiles, e.g. `nice -n 10` or a `bwrap …` sandbox |
| `UNDERLEAF_USE_TIMEOUT` | `true` | wrap compiles in coreutils `timeout` (kills the whole process tree) |
| `UNDERLEAF_MAX_UPLOAD_MB` | `50` | max upload / zip import size |
| `UNDERLEAF_MAX_DOC_KB` | `4096` | max size of an editable text file |
| `UNDERLEAF_SESSION_DAYS` | `30` | login session lifetime |
| `RUST_LOG` | `underleaf=info,warn` | log level |

### Production setup

`deploy/` has a hardened **systemd** unit, a **Caddyfile** (automatic HTTPS), and an **nginx** config.
The server rejects cross-origin WebSocket handshakes by comparing `Origin` with `Host`. With nginx,
forward `Host $http_host` as shown in the example config.

There is also a `Dockerfile` if you prefer containers.

## Security notes

Compiles run `latexmk -norc` (a project's `latexmkrc` is never executed) with:

* `shell_escape=f`: no `\write18` or shell commands;
* `openin_any=p` / `openout_any=p`: TeX cannot read or write files outside the project directory
  (e.g. `\input{/etc/passwd}` fails);
* a timeout that kills the whole process group, plus a global concurrency limit.

LuaLaTeX can still read arbitrary files through Lua's `io` library. If you host **untrusted users**, run
the service as a dedicated user (the systemd unit does this) and add a sandbox with
[bubblewrap](https://github.com/containers/bubblewrap) (`apt install bubblewrap`). This hides the database
and uploads from TeX and allows writes only into the build directory:

```
UNDERLEAF_COMPILE_WRAPPER=bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /var/lib/underleaf --bind /var/lib/underleaf/compile /var/lib/underleaf/compile --unshare-all --die-with-parent
```

(`UNDERLEAF_DATA` must then be the absolute path `/var/lib/underleaf`.)

User-uploaded files are served with `Content-Security-Policy: sandbox`, so an uploaded SVG or HTML file
cannot run scripts on your domain.

## How it works

* **Storage**: SQLite (WAL) holds users, sessions, projects, the file tree and text documents. Binary files
  are stored once per content hash in `data/blobs/`, and unreferenced blobs are garbage-collected hourly.
* **Collaboration** uses the central-authority model of `@codemirror/collab`. Each client pushes changes
  tagged with the document version they are based on. The server accepts them only if that version is
  current, applies them to an in-memory rope, and broadcasts them to every client in the file. A client
  that loses a race rebases its pending edits locally and retries. The server never has to transform
  operations, which keeps it tiny and fast. Open documents are saved to SQLite every 2 seconds and
  unloaded from memory when idle. Reconnecting clients resume from their last version without
  reloading.
* **Compilation**: each project gets a persistent directory in `data/compile/<id>`. Only changed files are
  rewritten before `latexmk` runs, so recompiles are incremental. Documents still being edited are
  compiled from memory, so the PDF always matches what you see.

## Layout

```
src/
  main.rs      startup, routes, background jobs, CLI
  auth.rs      accounts, sessions, admin API
  projects.rs  projects, sharing, templates, chat history
  files.rs     file tree, uploads, blob store
  collab.rs    WebSocket hub: document sync, cursors, presence, chat
  textops.rs   applies CodeMirror change sets to a rope
  compile.rs   latexmk runner + log parser
  zipio.rs     zip import / export
  assets.rs    embedded frontend
web/
  src/         vanilla JS + CodeMirror 6 (bundled by esbuild)
  static/      index.html, style.css, app.js (generated)
```

## Not implemented (yet)

File history and versions, track changes and comments, SyncTeX (click-to-source in the PDF), and a
rich-text mode. The architecture leaves room for all of them.
