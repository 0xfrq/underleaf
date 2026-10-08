// Tiny DOM helpers: no framework, just functions.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v === "boolean") el[k] = v;
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

const ICONS = {
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H7.5a2 2 0 0 0-1.9 1.4L3 18z"/><path d="M3 18l2.6-7.6A2 2 0 0 1 7.5 9H21l-2.6 8.6a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-1z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  tex: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M12 13v5"/>',
  newFile: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 12v6M9 15h6"/>',
  newFolder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  more: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  log: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><rect x="3" y="4.5" width="2.5" height="3" rx=".5"/><rect x="3" y="10.5" width="2.5" height="3" rx=".5"/><rect x="3" y="16.5" width="2.5" height="3" rx=".5"/>',
  backlog: '<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  timeline: '<path d="M3 4v16M7 7h8M10 12h10M7 17h6"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17v-5M13 17V8M18 17v-9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
};

export function icon(name) {
  const span = document.createElement("span");
  span.className = "ico";
  span.style.display = "inline-grid";
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.file}</svg>`;
  return span;
}

export function logo() {
  const span = document.createElement("span");
  span.style.display = "inline-grid";
  span.innerHTML = '<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#138a5b"/><path d="M9 22c0-8 5-13 14-13-1 9-6 14-14 13z" fill="#fff"/><path d="M9 22l7-7" stroke="#138a5b" stroke-width="1.6"/></svg>';
  return span;
}

// ---------------------------------------------------------------------------

let toastHost = null;
export function toast(msg, kind = "info", ms = 3800) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h("div", { class: "toasts" });
    document.body.append(toastHost);
  }
  const t = h("div", { class: `toast ${kind}`, role: "status" }, msg);
  toastHost.append(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 320);
  }, ms);
}

// Open modals, innermost last: Escape only closes the top one. Pages may remove overlays
// directly when they unmount, so disconnected entries are ignored.
const modalStack = [];
const topModal = () => modalStack.filter((o) => o.isConnected).pop();

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const overlay = h("div", { class: "modal-overlay" });
  const box = h(
    "div",
    { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" },
    h("div", { class: "modal-head" }, h("h3", null, title), h("button", { class: "icon-btn", title: "Close", onclick: () => close() }, icon("close"))),
    h("div", { class: "modal-body" }, body),
    actions.length ? h("div", { class: "modal-actions" }, actions) : null,
  );
  overlay.append(box);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && topModal() === overlay) {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  for (let i = modalStack.length - 1; i >= 0; i--) if (!modalStack[i].isConnected) modalStack.splice(i, 1);
  modalStack.push(overlay);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    const i = modalStack.indexOf(overlay);
    if (i >= 0) modalStack.splice(i, 1);
    document.removeEventListener("keydown", onKey);
    if (onClose) onClose();
  }
  setTimeout(() => {
    const f = box.querySelector(".modal-body input, .modal-body select, .modal-body textarea");
    if (f) f.focus();
  }, 0);
  return { close, el: box };
}

export function promptDialog(title, { label = "", value = "", okText = "OK", placeholder = "", selectStem = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h("input", { type: "text", placeholder });
    input.value = value;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v ? v : null);
    };
    const form = h(
      "form",
      { class: "form", onsubmit: (e) => { e.preventDefault(); finish(input.value.trim()); } },
      label ? h("label", null, label) : null,
      input,
    );
    const m = modal({
      title,
      body: form,
      actions: [
        h("button", { class: "btn", onclick: () => finish(null) }, "Cancel"),
        h("button", { class: "btn primary", onclick: () => finish(input.value.trim()) }, okText),
      ],
      onClose: () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      },
    });
    setTimeout(() => {
      input.focus();
      const dot = value.lastIndexOf(".");
      input.setSelectionRange(0, selectStem && dot > 0 ? dot : value.length);
    }, 0);
  });
}

export function confirmDialog(title, message, { okText = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title,
      body: h("p", null, message),
      actions: [
        h("button", { class: "btn", onclick: () => finish(false) }, "Cancel"),
        h("button", { class: "btn " + (danger ? "danger solid" : "primary"), onclick: () => finish(true) }, okText),
      ],
      onClose: () => {
        if (!done) {
          done = true;
          resolve(false);
        }
      },
    });
  });
}

export function contextMenu(x, y, items) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = h("div", { class: "ctx-menu", role: "menu" });
  for (const it of items) {
    if (!it) continue;
    if (it === "-") {
      menu.append(h("hr"));
      continue;
    }
    menu.append(
      h("button", {
        class: it.danger ? "danger" : "",
        role: "menuitem",
        onclick: () => {
          close();
          it.action();
        },
      }, it.label),
    );
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 8)) + "px";
  menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 8)) + "px";
  const onDown = (e) => {
    if (!menu.contains(e.target)) close();
  };
  // Capture phase, so Escape closes the menu without also closing a modal underneath.
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  function close() {
    menu.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  }
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  return close;
}

// ---------------------------------------------------------------------------

const PALETTE = ["#e5484d", "#2f6fdb", "#12a594", "#d6409f", "#f76b15", "#8e4ec6", "#0d74ce", "#46a758", "#c2410c", "#7c66dc"];
export function colorFor(id) {
  return PALETTE[Math.abs(Number(id) || 0) % PALETTE.length];
}

export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function avatar(user, extra = {}) {
  return h("span", { class: "avatar", style: { background: colorFor(user.user_id ?? user.id) }, title: user.display_name || user.name, ...extra }, initials(user.display_name || user.name));
}

export function timeAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function loadLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function saveLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
