//! Real-time collaboration.
//!
//! One WebSocket per (user, project). The server is the central authority used by
//! `@codemirror/collab`: clients push changes tagged with the document version they
//! are based on; the server accepts them only if that version is current, applies them
//! to its rope, and broadcasts them to every subscriber (including the sender, which
//! uses them as confirmation). Clients that lost the race rebase locally and retry.
//! This keeps the server tiny: no operational transform is needed on the server.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{header, HeaderMap},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use ropey::Rope;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::{
    auth::AuthUser,
    db::Db,
    error::{AppError, AppResult},
    projects::{require_role, Role},
    textops::apply_changes,
    util::{is_valid_id, normalize_newlines, now, random_hex},
    Shared,
};

/// How many recent updates are kept per document for clients catching up.
const MAX_HISTORY: usize = 2000;
/// Unused documents are evicted from memory after this long (they are saved first).
const DOC_IDLE: Duration = Duration::from_secs(120);
/// Outgoing message buffer per connection; a client that falls this far behind is dropped.
const SEND_BUFFER: usize = 1024;

type Tx = mpsc::Sender<Arc<str>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn arc(v: Value) -> Arc<str> {
    v.to_string().into()
}

struct Client {
    user_id: i64,
    name: String,
    role: Role,
    tx: Tx,
    doc: Option<String>,
    cursor: Option<(u64, u64)>,
}

struct Doc {
    rope: Rope,
    version: u64,
    /// Random id of this in-memory instance; resuming is only valid within one epoch.
    epoch: String,
    /// Serialized `{"changes":..,"clientID":..}` objects for the last versions.
    history: VecDeque<Arc<str>>,
    dirty: bool,
    last_used: Instant,
    subscribers: HashSet<u64>,
}

impl Doc {
    fn new(text: &str) -> Self {
        Doc {
            rope: Rope::from_str(text),
            version: 0,
            epoch: random_hex(6),
            history: VecDeque::new(),
            dirty: false,
            last_used: Instant::now(),
            subscribers: HashSet::new(),
        }
    }

    fn full_msg(&self, doc_id: &str) -> Arc<str> {
        arc(json!({
            "t": "doc",
            "doc": doc_id,
            "version": self.version,
            "epoch": self.epoch,
            "text": self.rope.to_string(),
        }))
    }

    /// Updates since `since`, or the full document if that is not possible.
    fn catch_up(&self, doc_id: &str, since: Option<u64>, same_epoch: bool) -> Arc<str> {
        if let (Some(v), true) = (since, same_epoch) {
            if v <= self.version {
                let behind = (self.version - v) as usize;
                if behind <= self.history.len() {
                    let start = self.history.len() - behind;
                    let ups: Vec<Arc<str>> = self.history.iter().skip(start).cloned().collect();
                    return updates_msg(doc_id, v, &ups);
                }
            }
        }
        self.full_msg(doc_id)
    }
}

fn updates_msg(doc_id: &str, version: u64, ups: &[Arc<str>]) -> Arc<str> {
    let mut s = String::with_capacity(64 + ups.iter().map(|u| u.len() + 1).sum::<usize>());
    s.push_str("{\"t\":\"updates\",\"doc\":");
    s.push_str(&serde_json::to_string(doc_id).unwrap_or_else(|_| "\"\"".into()));
    s.push_str(",\"version\":");
    s.push_str(&version.to_string());
    s.push_str(",\"updates\":[");
    for (i, u) in ups.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(u);
    }
    s.push_str("]}");
    s.into()
}

fn cursor_msg(doc_id: &str, conn: u64, c: &Client, anchor: u64, head: u64) -> Arc<str> {
    arc(json!({
        "t": "cursor",
        "doc": doc_id,
        "conn": conn,
        "user_id": c.user_id,
        "name": c.name,
        "anchor": anchor,
        "head": head,
    }))
}

enum PushOutcome {
    Resync,
    Nack(u64),
    Accepted {
        msg: Arc<str>,
        subs: Vec<u64>,
        failed: bool,
    },
}

#[derive(Default)]
struct RoomState {
    clients: HashMap<u64, Client>,
    docs: HashMap<String, Doc>,
}

impl RoomState {
    /// Queue a message; returns false if the client's buffer is full or closed.
    fn send(&self, conn: u64, msg: &Arc<str>) -> bool {
        match self.clients.get(&conn) {
            Some(c) => c.tx.try_send(msg.clone()).is_ok(),
            None => true,
        }
    }

    /// Send to many clients, dropping the ones that cannot keep up.
    fn send_many(&mut self, targets: &[u64], msg: &Arc<str>) {
        let failed: Vec<u64> = targets
            .iter()
            .copied()
            .filter(|t| !self.send(*t, msg))
            .collect();
        if !failed.is_empty() {
            for f in failed {
                self.remove_client(f);
            }
            self.broadcast_presence();
        }
    }

    fn subscribers_of(&self, doc_id: &str, except: Option<u64>) -> Vec<u64> {
        self.docs
            .get(doc_id)
            .map(|d| {
                d.subscribers
                    .iter()
                    .copied()
                    .filter(|s| Some(*s) != except)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn broadcast_presence(&self) {
        let users: Vec<Value> = self
            .clients
            .iter()
            .map(|(id, c)| {
                json!({
                    "conn": id,
                    "user_id": c.user_id,
                    "name": c.name,
                    "doc": c.doc,
                    "role": c.role,
                })
            })
            .collect();
        let msg = arc(json!({ "t": "presence", "users": users }));
        for id in self.clients.keys() {
            self.send(*id, &msg);
        }
    }

    fn unsubscribe_doc(&mut self, conn: u64, doc_id: &str) {
        if let Some(d) = self.docs.get_mut(doc_id) {
            d.subscribers.remove(&conn);
            d.last_used = Instant::now();
        }
        let msg = arc(json!({ "t": "cursor_clear", "doc": doc_id, "conn": conn }));
        for s in self.subscribers_of(doc_id, Some(conn)) {
            self.send(s, &msg);
        }
    }

    fn remove_client(&mut self, conn: u64) -> bool {
        let Some(c) = self.clients.remove(&conn) else {
            return false;
        };
        if let Some(doc) = c.doc {
            self.unsubscribe_doc(conn, &doc);
        }
        true
    }

    fn subscribe(&mut self, conn: u64, doc_id: &str, since: Option<u64>, epoch: Option<&str>) {
        let prev = match self.clients.get_mut(&conn) {
            Some(c) => {
                c.cursor = None;
                c.doc.replace(doc_id.to_string())
            }
            None => return,
        };
        if let Some(p) = prev.filter(|p| p.as_str() != doc_id) {
            self.unsubscribe_doc(conn, &p);
        }
        let msg = match self.docs.get_mut(doc_id) {
            Some(d) => {
                d.subscribers.insert(conn);
                d.last_used = Instant::now();
                let same_epoch = epoch == Some(d.epoch.as_str());
                d.catch_up(doc_id, since, same_epoch)
            }
            None => arc(json!({ "t": "error", "message": "document is not available" })),
        };
        self.send(conn, &msg);
        let cursors: Vec<Arc<str>> = self
            .clients
            .iter()
            .filter(|(id, c)| **id != conn && c.doc.as_deref() == Some(doc_id))
            .filter_map(|(id, c)| c.cursor.map(|(a, h)| cursor_msg(doc_id, *id, c, a, h)))
            .collect();
        for m in cursors {
            self.send(conn, &m);
        }
        self.broadcast_presence();
    }

    fn close_doc(&mut self, conn: u64) {
        let prev = self.clients.get_mut(&conn).and_then(|c| {
            c.cursor = None;
            c.doc.take()
        });
        if let Some(p) = prev {
            self.unsubscribe_doc(conn, &p);
            self.broadcast_presence();
        }
    }

    fn push(
        &mut self,
        conn: u64,
        doc_id: &str,
        version: u64,
        updates: Vec<UpdateIn>,
        max_bytes: usize,
    ) {
        let (can_edit, on_doc) = match self.clients.get(&conn) {
            Some(c) => (c.role.can_edit(), c.doc.as_deref() == Some(doc_id)),
            None => return,
        };
        if !can_edit {
            self.send(
                conn,
                &arc(json!({ "t": "error", "message": "you have read-only access" })),
            );
            return;
        }
        let outcome = match self.docs.get_mut(doc_id) {
            None => PushOutcome::Resync,
            Some(_) if !on_doc => PushOutcome::Resync,
            Some(d) if version != d.version => PushOutcome::Nack(d.version),
            Some(d) => {
                let start = d.version;
                let mut accepted = Vec::with_capacity(updates.len());
                let mut failed = false;
                for u in updates {
                    if u.client_id.len() > 64 {
                        failed = true;
                        break;
                    }
                    // Rope clones are O(1) (shared nodes), so validating on a copy is cheap.
                    let mut next = d.rope.clone();
                    if apply_changes(&mut next, &u.changes).is_err() || next.len_bytes() > max_bytes
                    {
                        failed = true;
                        break;
                    }
                    d.rope = next;
                    let entry = arc(json!({ "changes": u.changes, "clientID": u.client_id }));
                    d.history.push_back(entry.clone());
                    d.version += 1;
                    accepted.push(entry);
                }
                while d.history.len() > MAX_HISTORY {
                    d.history.pop_front();
                }
                if !accepted.is_empty() {
                    d.dirty = true;
                    d.last_used = Instant::now();
                }
                PushOutcome::Accepted {
                    msg: updates_msg(doc_id, start, &accepted),
                    subs: if accepted.is_empty() {
                        Vec::new()
                    } else {
                        d.subscribers.iter().copied().collect()
                    },
                    failed,
                }
            }
        };
        match outcome {
            PushOutcome::Resync => {
                self.send(conn, &arc(json!({ "t": "resync", "doc": doc_id })));
            }
            PushOutcome::Nack(v) => {
                self.send(
                    conn,
                    &arc(json!({ "t": "nack", "doc": doc_id, "version": v })),
                );
            }
            PushOutcome::Accepted { msg, subs, failed } => {
                self.send_many(&subs, &msg);
                if failed {
                    self.send(conn, &arc(json!({ "t": "resync", "doc": doc_id })));
                }
            }
        }
    }

    fn pull(&mut self, conn: u64, doc_id: &str, version: u64) {
        let subscribed = self
            .clients
            .get(&conn)
            .is_some_and(|c| c.doc.as_deref() == Some(doc_id));
        let msg = match self.docs.get(doc_id) {
            Some(d) if subscribed => d.catch_up(doc_id, Some(version), true),
            _ => arc(json!({ "t": "resync", "doc": doc_id })),
        };
        self.send(conn, &msg);
    }

    fn cursor(&mut self, conn: u64, doc_id: &str, anchor: u64, head: u64) {
        let msg = match self.clients.get_mut(&conn) {
            Some(c) if c.doc.as_deref() == Some(doc_id) => {
                c.cursor = Some((anchor, head));
                let c = &*c;
                cursor_msg(doc_id, conn, c, anchor, head)
            }
            _ => return,
        };
        for s in self.subscribers_of(doc_id, Some(conn)) {
            self.send(s, &msg);
        }
    }
}

pub struct Room {
    id: String,
    state: Mutex<RoomState>,
}

pub struct Hub {
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    next_conn: AtomicU64,
    max_doc_bytes: usize,
}

impl Hub {
    pub fn new(max_doc_bytes: usize) -> Self {
        Hub {
            rooms: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(0),
            max_doc_bytes,
        }
    }

    fn next_conn(&self) -> u64 {
        self.next_conn.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn room(&self, pid: &str) -> Option<Arc<Room>> {
        lock(&self.rooms).get(pid).cloned()
    }

    /// Get-or-create the room and register the client atomically, so the flusher can
    /// never remove a room between creation and join.
    fn join(&self, pid: &str, conn: u64, client: Client) -> Arc<Room> {
        let mut rooms = lock(&self.rooms);
        let room = rooms
            .entry(pid.to_string())
            .or_insert_with(|| {
                Arc::new(Room {
                    id: pid.to_string(),
                    state: Mutex::new(RoomState::default()),
                })
            })
            .clone();
        let mut st = lock(&room.state);
        st.clients.insert(conn, client);
        st.broadcast_presence();
        drop(st);
        room
    }

    fn leave(&self, room: &Room, conn: u64) {
        let mut st = lock(&room.state);
        if st.remove_client(conn) {
            st.broadcast_presence();
        }
    }

    /// Send a message to every client connected to a project.
    pub fn broadcast(&self, pid: &str, msg: &Value) {
        if let Some(r) = self.room(pid) {
            let msg = arc(msg.clone());
            let mut st = lock(&r.state);
            let ids: Vec<u64> = st.clients.keys().copied().collect();
            st.send_many(&ids, &msg);
        }
    }

    /// Disconnect all sessions of a user (after their access changed).
    pub fn kick_user(&self, pid: &str, uid: i64) {
        if let Some(r) = self.room(pid) {
            let mut st = lock(&r.state);
            let ids: Vec<u64> = st
                .clients
                .iter()
                .filter(|(_, c)| c.user_id == uid)
                .map(|(id, _)| *id)
                .collect();
            if !ids.is_empty() {
                for id in ids {
                    st.remove_client(id);
                }
                st.broadcast_presence();
            }
        }
    }

    /// Current text of every document of the project that is loaded in memory.
    pub fn live_texts(&self, pid: &str) -> HashMap<String, String> {
        match self.room(pid) {
            Some(r) => lock(&r.state)
                .docs
                .iter()
                .map(|(id, d)| (id.clone(), d.rope.to_string()))
                .collect(),
            None => HashMap::new(),
        }
    }

    pub fn doc_text(&self, pid: &str, doc_id: &str) -> Option<String> {
        let r = self.room(pid)?;
        let st = lock(&r.state);
        st.docs.get(doc_id).map(|d| d.rope.to_string())
    }

    /// Forget documents that were deleted (or turned into binary files).
    pub fn remove_docs(&self, pid: &str, ids: &[String]) {
        let Some(r) = self.room(pid) else { return };
        let mut st = lock(&r.state);
        let mut changed = false;
        for id in ids {
            if let Some(d) = st.docs.remove(id) {
                let msg = arc(json!({ "t": "deleted", "doc": id }));
                for s in d.subscribers {
                    st.send(s, &msg);
                }
            }
            for c in st.clients.values_mut() {
                if c.doc.as_deref() == Some(id.as_str()) {
                    c.doc = None;
                    c.cursor = None;
                    changed = true;
                }
            }
        }
        if changed {
            st.broadcast_presence();
        }
    }

    /// Replace a loaded document's content (e.g. overwritten by an upload).
    pub fn reset_doc(&self, pid: &str, doc_id: &str, text: &str) {
        let Some(r) = self.room(pid) else { return };
        let mut st = lock(&r.state);
        let Some(d) = st.docs.get_mut(doc_id) else {
            return;
        };
        d.rope = Rope::from_str(text);
        d.version += 1;
        d.epoch = random_hex(6);
        d.history.clear();
        d.dirty = true;
        let msg = d.full_msg(doc_id);
        let subs: Vec<u64> = d.subscribers.iter().copied().collect();
        st.send_many(&subs, &msg);
    }

    /// The project was deleted: tell everyone and close their connections.
    pub fn drop_project(&self, pid: &str) {
        let room = lock(&self.rooms).remove(pid);
        if let Some(r) = room {
            let mut st = lock(&r.state);
            let msg = arc(json!({ "t": "project_deleted" }));
            for id in st.clients.keys() {
                st.send(*id, &msg);
            }
            st.clients.clear();
            st.docs.clear();
        }
    }

    /// Persist dirty documents, evict idle ones and remove empty rooms.
    pub async fn flush(&self, db: &Db) {
        let rooms: Vec<Arc<Room>> = lock(&self.rooms).values().cloned().collect();
        let mut writes: Vec<(String, String, String)> = Vec::new();
        for r in &rooms {
            let mut st = lock(&r.state);
            for (id, d) in st.docs.iter_mut() {
                if d.dirty {
                    d.dirty = false;
                    writes.push((r.id.clone(), id.clone(), d.rope.to_string()));
                }
            }
        }
        if !writes.is_empty() {
            let keys: Vec<(String, String)> = writes
                .iter()
                .map(|(p, i, _)| (p.clone(), i.clone()))
                .collect();
            let res = db
                .call(move |c| {
                    let t = now();
                    let tx = c.transaction()?;
                    {
                        let mut up = tx.prepare_cached(
                            "UPDATE files SET content = ?1, size = ?2, updated_at = ?3
                             WHERE id = ?4 AND project_id = ?5 AND kind = 'doc'",
                        )?;
                        let mut pj =
                            tx.prepare_cached("UPDATE projects SET updated_at = ?1 WHERE id = ?2")?;
                        let mut touched = HashSet::new();
                        for (p, i, text) in &writes {
                            up.execute(params![text, text.len() as i64, t, i, p])?;
                            if touched.insert(p.clone()) {
                                pj.execute(params![t, p])?;
                            }
                        }
                    }
                    tx.commit()?;
                    Ok(())
                })
                .await;
            if let Err(e) = res {
                tracing::error!("failed to save documents: {e}");
                for (p, i) in keys {
                    if let Some(r) = self.room(&p) {
                        if let Some(d) = lock(&r.state).docs.get_mut(&i) {
                            d.dirty = true;
                        }
                    }
                }
            }
        }
        let now_i = Instant::now();
        for r in &rooms {
            let mut st = lock(&r.state);
            st.docs.retain(|_, d| {
                d.dirty || !d.subscribers.is_empty() || now_i.duration_since(d.last_used) < DOC_IDLE
            });
        }
        let mut map = lock(&self.rooms);
        map.retain(|_, r| {
            let st = lock(&r.state);
            !st.clients.is_empty() || !st.docs.is_empty()
        });
    }
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct UpdateIn {
    changes: Value,
    #[serde(rename = "clientID")]
    client_id: String,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum ClientMsg {
    Open {
        doc: String,
        #[serde(default)]
        version: Option<u64>,
        #[serde(default)]
        epoch: Option<String>,
    },
    Close,
    Push {
        doc: String,
        version: u64,
        updates: Vec<UpdateIn>,
    },
    Pull {
        doc: String,
        version: u64,
    },
    Cursor {
        doc: String,
        anchor: u64,
        head: u64,
    },
    Chat {
        body: String,
    },
    Ping,
}

/// Reject cross-site WebSocket handshakes.
fn check_origin(headers: &HeaderMap) -> AppResult<()> {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return Ok(());
    };
    let origin_host = origin.split("://").nth(1).unwrap_or(origin);
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if origin_host.eq_ignore_ascii_case(host) {
        Ok(())
    } else {
        Err(AppError::forbidden("cross-origin websocket rejected"))
    }
}

pub async fn ws_handler(
    State(app): State<Shared>,
    Path(pid): Path<String>,
    headers: HeaderMap,
    user: AuthUser,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    check_origin(&headers)?;
    let role = require_role(&app, &pid, user.id).await?;
    Ok(ws
        .max_message_size(16 << 20)
        .on_upgrade(move |socket| run_socket(app, socket, pid, user, role)))
}

async fn run_socket(app: Shared, socket: WebSocket, pid: String, user: AuthUser, role: Role) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Arc<str>>(SEND_BUFFER);
    let conn = app.hub.next_conn();
    let _ = tx.try_send(arc(json!({
        "t": "hello",
        "conn": conn,
        "user_id": user.id,
        "role": role,
    })));
    let room = app.hub.join(
        &pid,
        conn,
        Client {
            user_id: user.id,
            name: user.display_name.clone(),
            role,
            tx,
            doc: None,
            cursor: None,
        },
    );

    let mut send_task = tokio::spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_secs(25));
        ping.tick().await;
        loop {
            tokio::select! {
                m = rx.recv() => match m {
                    Some(m) => {
                        if sink.send(Message::Text(m.to_string())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Vec::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = sink.close().await;
    });

    loop {
        tokio::select! {
            m = stream.next() => match m {
                Some(Ok(Message::Text(t))) => handle(&app, &room, conn, &t).await,
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            _ = &mut send_task => break,
        }
    }
    send_task.abort();
    app.hub.leave(&room, conn);
}

async fn handle(app: &Shared, room: &Arc<Room>, conn: u64, text: &str) {
    let Ok(msg) = serde_json::from_str::<ClientMsg>(text) else {
        return;
    };
    match msg {
        ClientMsg::Open {
            doc,
            version,
            epoch,
        } => {
            open_doc(app, room, conn, doc, version, epoch).await;
        }
        ClientMsg::Close => {
            lock(&room.state).close_doc(conn);
        }
        ClientMsg::Push {
            doc,
            version,
            updates,
        } => {
            let max = app.hub.max_doc_bytes;
            lock(&room.state).push(conn, &doc, version, updates, max);
        }
        ClientMsg::Pull { doc, version } => {
            lock(&room.state).pull(conn, &doc, version);
        }
        ClientMsg::Cursor { doc, anchor, head } => {
            lock(&room.state).cursor(conn, &doc, anchor, head);
        }
        ClientMsg::Chat { body } => {
            chat(app, room, conn, body).await;
        }
        ClientMsg::Ping => {
            lock(&room.state).send(conn, &arc(json!({ "t": "pong" })));
        }
    }
}

async fn open_doc(
    app: &Shared,
    room: &Arc<Room>,
    conn: u64,
    doc: String,
    version: Option<u64>,
    epoch: Option<String>,
) {
    let error = |msg: &str| {
        let m = arc(json!({ "t": "error", "doc": doc, "message": msg }));
        lock(&room.state).send(conn, &m);
    };
    if !is_valid_id(&doc) {
        error("invalid document id");
        return;
    }
    let loaded = lock(&room.state).docs.contains_key(&doc);
    if !loaded {
        let (d, p) = (doc.clone(), room.id.clone());
        let res = app
            .db
            .call(move |c| {
                Ok(c.query_row(
                    "SELECT content FROM files WHERE id = ?1 AND project_id = ?2 AND kind = 'doc'",
                    params![d, p],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?)
            })
            .await;
        match res {
            Ok(Some(text)) => {
                let text = normalize_newlines(text.unwrap_or_default());
                lock(&room.state)
                    .docs
                    .entry(doc.clone())
                    .or_insert_with(|| Doc::new(&text));
            }
            Ok(None) => {
                error("document not found");
                return;
            }
            Err(e) => {
                tracing::error!("loading document {doc}: {e}");
                error("could not load document");
                return;
            }
        }
    }
    lock(&room.state).subscribe(conn, &doc, version, epoch.as_deref());
}

async fn chat(app: &Shared, room: &Arc<Room>, conn: u64, body: String) {
    let body = body.trim().to_string();
    if body.is_empty() || body.chars().count() > 4000 {
        return;
    }
    let who = {
        let st = lock(&room.state);
        st.clients.get(&conn).map(|c| (c.user_id, c.name.clone()))
    };
    let Some((uid, name)) = who else { return };
    let t = now();
    let (p, b) = (room.id.clone(), body.clone());
    let res = app
        .db
        .call(move |c| {
            c.execute(
                "INSERT INTO chat (project_id, user_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![p, uid, b, t],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await;
    match res {
        Ok(id) => app.hub.broadcast(
            &room.id,
            &json!({
                "t": "chat",
                "msg": { "id": id, "user_id": uid, "name": name, "body": body, "created_at": t },
            }),
        ),
        Err(e) => tracing::error!("chat insert failed: {e}"),
    }
}
