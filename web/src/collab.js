// Client side of the collaboration protocol (see src/collab.rs) plus remote cursors.

import { ChangeSet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { collab, receiveUpdates, sendableUpdates, getSyncedVersion, getClientID } from "@codemirror/collab";

/** WebSocket for one project with automatic reconnection. */
export class ProjectSocket {
  constructor(pid, onMessage, onState) {
    this.pid = pid;
    this.onMessage = onMessage;
    this.onState = onState;
    this.connected = false;
    this.closed = false;
    this.retry = 0;
    this.connect();
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/projects/${this.pid}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.onState("open");
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      if (this.closed) return;
      this.onState("closed");
      const delay = Math.min(10000, 400 * 2 ** this.retry++) + Math.random() * 300;
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  send(obj) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.ws) this.ws.close();
  }
}

/**
 * Builds the collab extension for one document.
 * Returns { extension, controller() } where controller() is the live plugin instance.
 */
export function collabSync({ socket, docId, version, epoch, canEdit, onStatus }) {
  let instance = null;

  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.inflight = false;
        this.ready = true;
        this.epoch = epoch;
        this.timer = null;
        instance = this;
        this.status();
      }

      update(u) {
        if (u.docChanged) {
          this.push();
          this.status();
        }
      }

      hasPending() {
        return sendableUpdates(this.view.state).length > 0;
      }

      push() {
        if (!canEdit || this.inflight || !this.ready || !socket.connected) return;
        const ups = sendableUpdates(this.view.state);
        if (!ups.length) return;
        this.inflight = true;
        const ok = socket.send({
          t: "push",
          doc: docId,
          version: getSyncedVersion(this.view.state),
          updates: ups.map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })),
        });
        if (!ok) {
          this.inflight = false;
          return;
        }
        clearTimeout(this.timer);
        // Safety net: if the server never answers, try again.
        this.timer = setTimeout(() => {
          this.inflight = false;
          this.push();
        }, 8000);
      }

      /** Server broadcast of accepted updates starting at `version`. */
      receive(version, updates) {
        this.ready = true;
        const synced = getSyncedVersion(this.view.state);
        if (version > synced) {
          // We missed something; ask for the gap.
          socket.send({ t: "pull", doc: docId, version: synced });
          return;
        }
        const fresh = updates.slice(synced - version);
        if (fresh.length) {
          const me = getClientID(this.view.state);
          if (fresh.some((u) => u.clientID === me)) {
            this.inflight = false;
            clearTimeout(this.timer);
          }
          const decoded = fresh.map((u) => ({ changes: ChangeSet.fromJSON(u.changes), clientID: u.clientID }));
          this.view.dispatch(receiveUpdates(this.view.state, decoded));
        }
        this.push();
        this.status();
      }

      /** Our push was based on an outdated version. */
      nack(serverVersion) {
        this.inflight = false;
        clearTimeout(this.timer);
        const synced = getSyncedVersion(this.view.state);
        if (serverVersion > synced) socket.send({ t: "pull", doc: docId, version: synced });
        else if (serverVersion < synced) socket.send({ t: "open", doc: docId });
        else this.push();
      }

      /** Socket came back: resume from our synced version. */
      reconnected() {
        this.inflight = false;
        this.ready = false;
        clearTimeout(this.timer);
        socket.send({ t: "open", doc: docId, version: getSyncedVersion(this.view.state), epoch: this.epoch });
        this.status();
      }

      status() {
        if (!onStatus) return;
        if (!canEdit) onStatus("readonly");
        else if (!socket.connected) onStatus("offline");
        else onStatus(this.hasPending() ? "saving" : "saved");
      }

      destroy() {
        clearTimeout(this.timer);
        if (instance === this) instance = null;
      }
    },
  );

  return {
    extension: [collab({ startVersion: version }), plugin],
    controller: () => instance,
  };
}

// ---------------------------------------------------------------------------
// Remote cursors
// ---------------------------------------------------------------------------

export const setRemoteCursor = StateEffect.define();
export const removeRemoteCursor = StateEffect.define();

class CaretWidget extends WidgetType {
  constructor(name, color) {
    super();
    this.name = name;
    this.color = color;
  }
  eq(other) {
    return other.name === this.name && other.color === this.color;
  }
  toDOM() {
    const caret = document.createElement("span");
    caret.className = "cm-remote-caret";
    caret.style.borderColor = this.color;
    const label = document.createElement("span");
    label.className = "cm-remote-label";
    label.textContent = this.name;
    label.style.background = this.color;
    caret.append(label);
    return caret;
  }
  ignoreEvent() {
    return true;
  }
}

function buildDecorations(cursors, len) {
  const ranges = [];
  for (const c of cursors.values()) {
    const a = Math.min(c.anchor, len);
    const hd = Math.min(c.head, len);
    const from = Math.min(a, hd);
    const to = Math.max(a, hd);
    if (from < to) {
      ranges.push(Decoration.mark({ attributes: { style: `background-color: ${c.color}33` } }).range(from, to));
    }
    ranges.push(Decoration.widget({ widget: new CaretWidget(c.name, c.color), side: 1 }).range(hd));
  }
  return Decoration.set(ranges, true);
}

export const remoteCursors = StateField.define({
  create() {
    return { cursors: new Map(), deco: Decoration.none };
  },
  update(value, tr) {
    let cursors = value.cursors;
    let changed = false;
    if (tr.docChanged && cursors.size) {
      const next = new Map();
      for (const [k, c] of cursors) {
        next.set(k, { ...c, anchor: tr.changes.mapPos(Math.min(c.anchor, tr.startState.doc.length)), head: tr.changes.mapPos(Math.min(c.head, tr.startState.doc.length)) });
      }
      cursors = next;
      changed = true;
    }
    for (const e of tr.effects) {
      if (e.is(setRemoteCursor)) {
        if (!changed) cursors = new Map(cursors);
        cursors.set(e.value.conn, e.value);
        changed = true;
      } else if (e.is(removeRemoteCursor) && cursors.has(e.value)) {
        if (!changed) cursors = new Map(cursors);
        cursors.delete(e.value);
        changed = true;
      }
    }
    if (!changed) return value;
    return { cursors, deco: buildDecorations(cursors, tr.state.doc.length) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
