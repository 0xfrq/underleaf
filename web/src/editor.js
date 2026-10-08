// The project page: file tree, collaborative editor, PDF preview, logs and chat.

import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine,
} from "@codemirror/view";
import { EditorState, Transaction } from "@codemirror/state";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentOnInput, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { sendableUpdates } from "@codemirror/collab";

import { get, post, patch, del } from "./api.js";
import {
  h, icon, toast, modal, promptDialog, confirmDialog, contextMenu, avatar, colorFor, formatSize, timeAgo, loadLS, saveLS,
} from "./ui.js";
import { ProjectSocket, collabSync, remoteCursors, setRemoteCursor, removeRemoteCursor } from "./collab.js";
import { latexLanguage, highlightStyle, latexCompletion, isTexFile, extractLabels, extractBibKeys } from "./latex.js";
import { userMenuButton } from "./dashboard.js";
import { taskNotice } from "./tasks-common.js";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const UPLOAD_BATCH_BYTES = 40 * 1024 * 1024;

export async function openEditor(root, pid, ctx) {
  const project = await get(`/api/projects/${pid}`);

  const S = {
    project,
    role: project.role,
    canEdit: project.role !== "viewer",
    tree: project.tree,
    byId: new Map(),
    paths: new Map(),
    pathToId: new Map(),
    expanded: new Set(loadLS(`ul:exp:${pid}`, [])),
    selectedFolder: null,
    openId: null,
    sync: null,
    conn: null,
    presence: [],
    connected: false,
    everConnected: false,
    compiling: false,
    compileQueued: false,
    lastResult: null,
    pendingJump: null,
    autoCompile: loadLS("ul:autocompile", false),
    autoTimer: null,
    cursorTimer: null,
    chatOpen: false,
    chatLoaded: false,
    unread: 0,
    index: null,
    indexAt: 0,
    destroyed: false,
    panel: "pdf",
  };
  const cleanups = [];

  // ------------------------------------------------------------------ DOM
  const E = {};
  E.pname = h("button", { class: "pname", title: "Rename project", onclick: () => renameProject() }, project.name);
  E.online = h("div", { class: "online" });
  E.connDot = h("span", { class: "conn-dot off", title: "Connecting…" });
  E.chatBadge = h("span", { class: "badge hidden" });
  E.viewSwitch = h("div", { class: "view-switch" },
    ["files", "editor", "pdf"].map((v) => h("button", { class: "btn ghost sm", onclick: () => setView(v) }, v[0].toUpperCase() + v.slice(1))));

  const topbar = h("header", { class: "topbar" },
    h("a", { href: "/", "data-link": "", class: "icon-btn", title: "Back to projects" }, icon("back")),
    E.pname,
    E.connDot,
    h("div", { class: "spacer" }),
    E.viewSwitch,
    E.online,
    h("a", { href: `/project/${pid}/board`, "data-link": "", class: "btn ghost", title: "Task board" }, icon("board"), h("span", { class: "hide-narrow" }, "Tasks")),
    h("button", { class: "btn ghost", title: "Share", onclick: () => shareDialog() }, icon("share"), h("span", { class: "hide-narrow" }, "Share")),
    h("button", { class: "btn ghost", title: "Project settings", onclick: () => settingsDialog() }, icon("settings")),
    h("button", { class: "btn ghost", title: "Download project as .zip", onclick: () => (location.href = `/api/projects/${pid}/download`) }, icon("download")),
    h("button", { class: "btn ghost", title: "Chat", onclick: () => toggleChat() }, icon("chat"), E.chatBadge),
    userMenuButton(ctx));

  // Sidebar
  E.uploadInput = h("input", { type: "file", multiple: true, class: "hidden", onchange: () => uploadFromInput(E.uploadInput) });
  E.folderInput = h("input", { type: "file", multiple: true, class: "hidden", webkitdirectory: "", onchange: () => uploadFromInput(E.folderInput) });
  E.tree = h("div", { class: "tree" });
  const sidebar = h("aside", { class: "sidebar" },
    h("div", { class: "pane-head" },
      h("span", { class: "title" }, "Files"),
      h("div", { class: "spacer" }),
      S.canEdit ? [
        h("button", { class: "icon-btn", title: "New file", onclick: () => createEntry("doc") }, icon("newFile")),
        h("button", { class: "icon-btn", title: "New folder", onclick: () => createEntry("folder") }, icon("newFolder")),
        h("button", {
          class: "icon-btn",
          title: "Upload files or a folder",
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            contextMenu(r.left, r.bottom + 2, [
              { label: "Upload files…", action: () => E.uploadInput.click() },
              { label: "Upload folder…", action: () => E.folderInput.click() },
            ]);
          },
        }, icon("upload")),
      ] : null,
      E.uploadInput,
      E.folderInput),
    E.tree);

  // Editor pane
  E.filePath = h("span", { class: "path" }, "");
  E.saveState = h("span", { class: "save-state" });
  E.cmHost = h("div", { class: "cm-host" });
  E.loading = h("div", { class: "loading-overlay hidden" }, h("span", { class: "spinner" }));
  E.cmHost.append(E.loading);
  E.binary = h("div", { class: "binary-view hidden" });
  E.placeholder = h("div", { class: "placeholder" }, "Select a file to start editing.");
  E.togglePdf = h("button", { class: "icon-btn", title: "Toggle PDF preview", onclick: () => togglePreview() }, icon("pdf"));
  const editorPane = h("main", { class: "editor-pane" },
    h("div", { class: "pane-head file-head" }, E.filePath, h("div", { class: "spacer" }), E.saveState, E.togglePdf),
    E.cmHost, E.binary, E.placeholder);

  // Preview pane
  E.compileBtn = h("button", { class: "btn primary compile-btn", title: "Compile (Ctrl+S / Ctrl+Enter)", onclick: () => compile() }, icon("play"), h("span", null, "Recompile"));
  E.compileMenu = h("button", { class: "btn primary", title: "Compile options", onclick: (e) => compileMenu(e) }, "▾");
  E.logBtn = h("button", { class: "btn ghost sm", onclick: () => showPanel(S.panel === "logs" ? "pdf" : "logs") }, icon("log"), "Logs", h("span", { class: "log-counts" }));
  E.pdfLink = h("a", { class: "icon-btn hidden", title: "Open PDF in a new tab", target: "_blank", rel: "noopener" }, icon("external"));
  E.pdfDownload = h("a", { class: "icon-btn hidden", title: "Download PDF", download: "output.pdf" }, icon("download"));
  E.pdfHost = h("div", { class: "pdf-host" }, h("div", { class: "placeholder", style: { height: "100%" } }, "Compile the project to see the PDF."));
  E.logs = h("div", { class: "logs hidden" });
  const previewPane = h("section", { class: "preview-pane" },
    h("div", { class: "pane-head" }, h("div", { class: "compile-group" }, E.compileBtn, E.compileMenu), E.logBtn, h("div", { class: "spacer" }), E.pdfLink, E.pdfDownload),
    h("div", { class: "preview-body" }, E.pdfHost, E.logs));

  // Chat
  E.chatList = h("div", { class: "chat-list" });
  E.chatInput = h("textarea", { placeholder: "Message collaborators… (Enter to send)" });
  E.chat = h("aside", { class: "chat hidden" },
    h("div", { class: "pane-head" }, h("span", { class: "title" }, "Chat"), h("div", { class: "spacer" }), h("button", { class: "icon-btn", onclick: () => toggleChat() }, icon("close"))),
    E.chatList,
    h("div", { class: "chat-input" }, E.chatInput));

  const splitL = h("div", { class: "split left" });
  const splitR = h("div", { class: "split right" });
  E.workspace = h("div", { class: "workspace", dataset: { view: "editor" } }, sidebar, splitL, editorPane, splitR, previewPane, E.chat);
  const page = h("div", { class: "editor-page" }, topbar, E.workspace);
  root.append(page);

  // Restore layout.
  const sideW = loadLS("ul:sideW", null);
  const pdfW = loadLS("ul:pdfW", null);
  if (sideW) E.workspace.style.setProperty("--side-w", sideW + "px");
  if (pdfW) E.workspace.style.setProperty("--pdf-w", pdfW + "px");
  if (loadLS("ul:hidePdf", false)) E.workspace.classList.add("no-pdf");
  splitter(splitL, (x) => {
    const r = E.workspace.getBoundingClientRect();
    const w = Math.max(140, Math.min(x - r.left, r.width * 0.5));
    E.workspace.style.setProperty("--side-w", w + "px");
    saveLS("ul:sideW", Math.round(w));
  });
  splitter(splitR, (x) => {
    const r = E.workspace.getBoundingClientRect();
    const w = Math.max(220, Math.min(r.right - x, r.width * 0.75));
    E.workspace.style.setProperty("--pdf-w", w + "px");
    saveLS("ul:pdfW", Math.round(w));
  });

  // ------------------------------------------------------------------ editor
  const view = new EditorView({ parent: E.cmHost, state: EditorState.create({ doc: "" }) });
  S.view = view;
  showPlaceholder("Select a file to start editing.");

  function baseExtensions(name) {
    const tex = isTexFile(name);
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(highlightStyle),
      tex ? latexLanguage : [],
      autocompletion(tex ? { override: [latexCompletion(bibKeys, labels)], icons: false } : { icons: false }),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (compile(), true) },
        { key: "Mod-Enter", preventDefault: true, run: () => (compile(), true) },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "off", autocapitalize: "off" }),
      remoteCursors,
      S.canEdit ? [] : [EditorState.readOnly.of(true)],
      EditorView.updateListener.of(onEditorUpdate),
    ];
  }

  function onEditorUpdate(u) {
    if (!S.sync) return;
    if (u.selectionSet || u.docChanged) scheduleCursorSend();
    if (u.docChanged && S.autoCompile && u.transactions.some((tr) => tr.annotation(Transaction.userEvent) !== undefined)) {
      clearTimeout(S.autoTimer);
      S.autoTimer = setTimeout(() => compile(), 2500);
    }
  }

  function scheduleCursorSend() {
    if (S.cursorTimer) return;
    S.cursorTimer = setTimeout(() => {
      S.cursorTimer = null;
      if (!S.sync || !S.openId) return;
      const sel = view.state.selection.main;
      socket.send({ t: "cursor", doc: S.openId, anchor: sel.anchor, head: sel.head });
    }, 120);
  }

  function setSaveState(state) {
    const text = { saved: "Saved", saving: "Saving…", offline: "Offline: changes will sync when reconnected", readonly: "Read only" }[state] || "";
    E.saveState.className = "save-state " + state;
    E.saveState.textContent = text;
  }

  function showPlaceholder(msg) {
    S.sync = null;
    E.cmHost.classList.add("hidden");
    E.binary.classList.add("hidden");
    E.placeholder.classList.remove("hidden");
    E.placeholder.textContent = msg;
    E.filePath.textContent = "";
    E.saveState.textContent = "";
  }

  // ------------------------------------------------------------------ tree
  function indexTree() {
    S.byId = new Map(S.tree.map((e) => [e.id, e]));
    S.paths = new Map();
    S.pathToId = new Map();
    const pathOf = (e, depth) => {
      if (S.paths.has(e.id)) return S.paths.get(e.id);
      const parent = e.parent_id ? S.byId.get(e.parent_id) : null;
      const p = parent && depth < 64 ? pathOf(parent, depth + 1) + "/" + e.name : e.name;
      S.paths.set(e.id, p);
      return p;
    };
    for (const e of S.tree) S.pathToId.set(pathOf(e, 0), e.id);
  }

  function children() {
    const kids = new Map();
    for (const e of S.tree) {
      const k = e.parent_id || "";
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(e);
    }
    for (const arr of kids.values()) {
      arr.sort((a, b) => {
        const fa = a.kind === "folder", fb = b.kind === "folder";
        if (fa !== fb) return fa ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      });
    }
    return kids;
  }

  function renderTree() {
    const kids = children();
    const editing = new Map();
    for (const u of S.presence) {
      if (u.doc && u.conn !== S.conn) {
        if (!editing.has(u.doc)) editing.set(u.doc, []);
        editing.get(u.doc).push(u);
      }
    }
    const frag = document.createDocumentFragment();
    const walk = (parent, depth) => {
      for (const e of kids.get(parent) || []) {
        frag.append(treeRow(e, depth, editing.get(e.id)));
        if (e.kind === "folder" && S.expanded.has(e.id)) walk(e.id, depth + 1);
      }
    };
    walk("", 0);
    E.tree.replaceChildren(frag);
    if (!S.tree.length) E.tree.append(h("div", { class: "muted pad" }, S.canEdit ? "No files yet. Create or upload one." : "No files."));
  }

  function fileIcon(e) {
    if (e.kind === "folder") return h("span", { class: "ficon folder" }, icon(S.expanded.has(e.id) ? "folderOpen" : "folder"));
    if (IMAGE_RE.test(e.name)) return h("span", { class: "ficon img" }, icon("image"));
    if (/\.(tex|sty|cls|bib)$/i.test(e.name)) return h("span", { class: "ficon tex" }, icon("tex"));
    return h("span", { class: "ficon" }, icon("file"));
  }

  function treeRow(e, depth, editors) {
    const isMain = e.id === S.project.main_file;
    const cls = ["tree-row"];
    if (e.id === S.openId) cls.push("active");
    const row = h("div", {
      class: cls.join(" "),
      style: { paddingLeft: 6 + depth * 14 + "px" },
      draggable: S.canEdit ? "true" : "false",
      title: S.paths.get(e.id) + (e.kind === "blob" ? ` (${formatSize(e.size)})` : ""),
    },
      h("span", { class: "caret" }, e.kind === "folder" ? (S.expanded.has(e.id) ? "▾" : "▸") : ""),
      fileIcon(e),
      h("span", { class: "fname" }, e.name),
      editors && editors.length ? h("span", { class: "dots" }, editors.slice(0, 3).map((u) => h("span", { style: { background: colorFor(u.user_id) }, title: u.name }))) : null,
      isMain ? h("span", { class: "main-badge", title: "Main document" }, "main") : null,
      h("button", { class: "icon-btn more", title: "Actions", onclick: (ev) => { ev.stopPropagation(); const r = ev.currentTarget.getBoundingClientRect(); fileMenu(e, r.left, r.bottom); } }, icon("more")));

    row.addEventListener("click", () => {
      if (e.kind === "folder") {
        S.selectedFolder = e.id;
        toggleFolder(e.id);
      } else {
        S.selectedFolder = e.parent_id || null;
        openFile(e.id);
      }
    });
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      fileMenu(e, ev.clientX, ev.clientY);
    });
    if (S.canEdit) {
      row.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("application/x-underleaf-id", e.id);
        ev.dataTransfer.effectAllowed = "move";
      });
      const target = e.kind === "folder" ? e.id : e.parent_id || "";
      row.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.add("drop");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove("drop");
        handleDrop(ev, target);
      });
    }
    return row;
  }

  function fileMenu(e, x, y) {
    const items = [];
    if (e.kind !== "folder") items.push({ label: "Open", action: () => openFile(e.id) });
    if (e.kind !== "folder") items.push({ label: "Download", action: () => (location.href = `/api/projects/${pid}/files/${e.id}/raw?download=1`) });
    if (S.canEdit) {
      if (e.kind === "folder") {
        items.push({ label: "New file here…", action: () => createEntry("doc", e.id) });
        items.push({ label: "New folder here…", action: () => createEntry("folder", e.id) });
        items.push({ label: "Upload here…", action: () => { S.selectedFolder = e.id; E.uploadInput.click(); } });
      }
      if (e.kind === "doc" && /\.tex$/i.test(e.name) && e.id !== S.project.main_file) {
        items.push({ label: "Set as main document", action: () => setMain(e.id) });
      }
      items.push("-");
      items.push({ label: "Rename…", action: () => renameEntry(e) });
      if (e.parent_id) items.push({ label: "Move to root", action: () => moveEntry(e.id, "") });
      items.push({ label: "Delete", danger: true, action: () => deleteEntry(e) });
    }
    contextMenu(x, y, items);
  }

  function toggleFolder(id) {
    if (S.expanded.has(id)) S.expanded.delete(id);
    else S.expanded.add(id);
    saveLS(`ul:exp:${pid}`, [...S.expanded]);
    renderTree();
  }

  function expandTo(id) {
    let e = S.byId.get(id);
    let guard = 0;
    while (e && e.parent_id && guard++ < 64) {
      S.expanded.add(e.parent_id);
      e = S.byId.get(e.parent_id);
    }
  }

  // Root drop zone
  if (S.canEdit) {
    E.tree.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      E.tree.classList.add("drop-root");
    });
    E.tree.addEventListener("dragleave", (ev) => {
      if (ev.target === E.tree) E.tree.classList.remove("drop-root");
    });
    E.tree.addEventListener("drop", (ev) => {
      ev.preventDefault();
      E.tree.classList.remove("drop-root");
      handleDrop(ev, "");
    });
  }

  function handleDrop(ev, folderId) {
    E.tree.classList.remove("drop-root");
    const id = ev.dataTransfer.getData("application/x-underleaf-id");
    if (id) {
      if (id !== folderId) moveEntry(id, folderId);
      return;
    }
    if (ev.dataTransfer.files && ev.dataTransfer.files.length) {
      collectDropped(ev.dataTransfer).then((list) => uploadFiles(list, folderId));
    }
  }

  // Must read entries synchronously inside the drop handler, before any await.
  function collectDropped(dt) {
    const entries = [...(dt.items || [])]
      .filter((i) => i.kind === "file")
      .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    const plainFiles = [...dt.files];
    return (async () => {
      if (!entries.some(Boolean)) return plainFiles.map((f) => ({ file: f, path: f.name }));
      const out = [];
      const walk = async (entry, prefix) => {
        if (entry.isFile) {
          const file = await new Promise((res, rej) => entry.file(res, rej));
          out.push({ file, path: prefix + file.name });
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const child of batch) await walk(child, prefix + entry.name + "/");
          }
        }
      };
      for (const en of entries) if (en) await walk(en, "");
      return out;
    })();
  }

  function uploadFromInput(input) {
    const list = [...input.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    input.value = "";
    uploadFiles(list, S.selectedFolder || "");
  }

  async function uploadFiles(list, folderId) {
    list = list.filter((x) => !/(^|\/)(\.DS_Store|Thumbs\.db|__MACOSX)(\/|$)/.test(x.path));
    if (!list.length) return;
    const batches = [];
    let cur = [];
    let size = 0;
    for (const item of list) {
      if (cur.length && (size + item.file.size > UPLOAD_BATCH_BYTES || cur.length >= 200)) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(item);
      size += item.file.size;
    }
    if (cur.length) batches.push(cur);
    toast(`Uploading ${list.length} file${list.length > 1 ? "s" : ""}…`);
    try {
      for (const batch of batches) {
        const fd = new FormData();
        if (folderId) fd.append("parent_id", folderId);
        for (const { file, path } of batch) {
          fd.append("path", path);
          fd.append("file", file, file.name);
        }
        await post(`/api/projects/${pid}/upload`, fd);
      }
      if (folderId) S.expanded.add(folderId);
      toast("Upload complete", "success");
      refreshTree();
    } catch (e) {
      toast(`Upload failed: ${e.message}`, "error");
    }
  }

  async function createEntry(kind, parentId) {
    const parent = parentId !== undefined ? parentId : S.selectedFolder || "";
    const name = await promptDialog(kind === "folder" ? "New folder" : "New file", {
      label: parent ? `In ${S.paths.get(parent)}/` : "In the project root",
      value: kind === "folder" ? "" : "chapter.tex",
      okText: "Create",
    });
    if (!name) return;
    try {
      const r = await post(`/api/projects/${pid}/files`, { parent_id: parent, name, kind });
      if (parent) S.expanded.add(parent);
      await refreshTree();
      if (kind === "doc") openFile(r.id);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function renameEntry(e) {
    const name = await promptDialog("Rename", { value: e.name, okText: "Rename" });
    if (!name || name === e.name) return;
    try {
      await patch(`/api/projects/${pid}/files/${e.id}`, { name });
      refreshTree();
    } catch (ex) {
      toast(ex.message, "error");
    }
  }

  async function moveEntry(id, folderId) {
    const e = S.byId.get(id);
    if (!e || (e.parent_id || "") === folderId) return;
    try {
      await patch(`/api/projects/${pid}/files/${id}`, { parent_id: folderId });
      if (folderId) S.expanded.add(folderId);
      refreshTree();
    } catch (ex) {
      toast(ex.message, "error");
    }
  }

  async function deleteEntry(e) {
    const what = e.kind === "folder" ? `the folder "${e.name}" and everything in it` : `"${e.name}"`;
    if (!(await confirmDialog("Delete", `Delete ${what}? This cannot be undone.`, { okText: "Delete", danger: true }))) return;
    try {
      await del(`/api/projects/${pid}/files/${e.id}`);
      refreshTree();
    } catch (ex) {
      toast(ex.message, "error");
    }
  }

  async function setMain(id) {
    try {
      await patch(`/api/projects/${pid}`, { main_file: id });
      S.project.main_file = id;
      renderTree();
      toast("Main document updated", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  let treeTimer = null;
  function refreshTree() {
    clearTimeout(treeTimer);
    return new Promise((resolve) => {
      treeTimer = setTimeout(async () => {
        try {
          S.tree = await get(`/api/projects/${pid}/tree`);
          S.index = null;
          indexTree();
          renderTree();
          if (S.openId && !S.byId.has(S.openId)) {
            S.openId = null;
            showPlaceholder("The open file was deleted.");
          } else if (S.openId) {
            E.filePath.textContent = S.paths.get(S.openId) || "";
          }
        } catch (e) {
          if (e.status === 404) projectGone();
        }
        resolve();
      }, 60);
    });
  }

  async function refreshProject() {
    try {
      const p = await get(`/api/projects/${pid}`);
      S.project = p;
      S.tree = p.tree;
      if (p.role !== S.role) {
        toast("Your access level changed; reloading.", "warn");
        ctx.navigate(location.pathname, true);
        return;
      }
      E.pname.textContent = p.name;
      document.title = `${p.name} - Underleaf`;
      indexTree();
      renderTree();
    } catch (e) {
      if (e.status === 404) projectGone();
    }
  }

  function projectGone() {
    if (S.destroyed) return;
    toast("This project no longer exists or you lost access to it.", "error");
    ctx.navigate("/");
  }

  // ------------------------------------------------------------------ files
  function openFile(id) {
    const e = S.byId.get(id);
    if (!e || e.kind === "folder") return;
    if (S.openId && S.openId !== id && S.sync) {
      const c = S.sync.controller();
      if (c && c.hasPending()) toast("Some changes were still syncing; they will be sent shortly.", "warn");
    }
    S.openId = id;
    S.pendingJumpFor = id;
    saveLS(`ul:open:${pid}`, id);
    expandTo(id);
    renderTree();
    E.placeholder.classList.add("hidden");
    E.filePath.textContent = S.paths.get(id) || e.name;
    setView("editor");

    if (e.kind === "doc") {
      E.binary.classList.add("hidden");
      E.binary.replaceChildren();
      E.cmHost.classList.remove("hidden");
      E.loading.classList.remove("hidden");
      S.sync = null;
      view.setState(EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)] }));
      setSaveState(S.connected ? "saving" : "offline");
      E.saveState.textContent = "Loading…";
      socket.send({ t: "open", doc: id });
    } else {
      S.sync = null;
      socket.send({ t: "close" });
      E.cmHost.classList.add("hidden");
      E.binary.classList.remove("hidden");
      E.saveState.textContent = formatSize(e.size);
      E.saveState.className = "save-state";
      const url = `/api/projects/${pid}/files/${id}/raw?v=${e.updated_at}`;
      const actions = h("div", { class: "row" },
        h("a", { class: "btn", href: `/api/projects/${pid}/files/${id}/raw?download=1` }, icon("download"), "Download"));
      if (IMAGE_RE.test(e.name)) {
        E.binary.replaceChildren(h("img", { src: url, alt: e.name }), actions);
      } else if (/\.pdf$/i.test(e.name)) {
        E.binary.replaceChildren(h("iframe", { src: url, title: e.name }), actions);
      } else {
        E.binary.replaceChildren(h("div", { class: "muted" }, `${e.name} is a binary file (${formatSize(e.size)}).`), actions);
      }
    }
  }

  function onDocMessage(m) {
    if (m.doc !== S.openId) return;
    const e = S.byId.get(m.doc);
    let lostChanges = false;
    if (S.sync) {
      const c = S.sync.controller();
      lostChanges = !!(c && c.hasPending());
    }
    const sync = collabSync({
      socket,
      docId: m.doc,
      version: m.version,
      epoch: m.epoch,
      canEdit: S.canEdit,
      onStatus: setSaveState,
    });
    S.sync = sync;
    const prevSel = S.keepSelection;
    view.setState(EditorState.create({ doc: m.text, extensions: [baseExtensions(e ? e.name : ""), sync.extension] }));
    E.loading.classList.add("hidden");
    if (lostChanges) toast("The document was reloaded from the server; your last unsynced edits could not be applied.", "warn", 6000);
    if (S.pendingJump && S.pendingJump.id === m.doc) {
      jumpToLine(S.pendingJump.line);
      S.pendingJump = null;
    } else if (prevSel && prevSel.id === m.doc) {
      const pos = Math.min(prevSel.pos, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    }
    S.keepSelection = null;
    if (window.matchMedia("(min-width: 861px)").matches) view.focus();
  }

  function jumpToLine(n) {
    const doc = view.state.doc;
    const line = doc.line(Math.max(1, Math.min(n || 1, doc.lines)));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    view.focus();
  }

  // ------------------------------------------------------------------ completion data
  async function projectIndex() {
    if (S.index && Date.now() - S.indexAt < 30000) return S.index;
    const docs = S.tree.filter((e) => e.kind === "doc" && /\.(tex|bib)$/i.test(e.name)).slice(0, 60);
    const texts = await Promise.all(docs.map((d) =>
      fetch(`/api/projects/${pid}/files/${d.id}/raw`, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : "")).catch(() => "")));
    const labels = new Set();
    const keys = new Set();
    docs.forEach((d, i) => {
      if (/\.bib$/i.test(d.name)) extractBibKeys(texts[i]).forEach((k) => keys.add(k));
      else extractLabels(texts[i]).forEach((l) => labels.add(l));
    });
    S.index = { labels: [...labels], keys: [...keys] };
    S.indexAt = Date.now();
    return S.index;
  }

  async function bibKeys() {
    try {
      return (await projectIndex()).keys;
    } catch {
      return [];
    }
  }

  function labels() {
    const out = new Set(extractLabels(view.state.doc.toString()));
    if (S.index) S.index.labels.forEach((l) => out.add(l));
    else projectIndex().catch(() => {});
    return [...out];
  }

  // ------------------------------------------------------------------ compile
  function waitForSync(ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        let pending = false;
        if (S.sync) {
          try {
            pending = sendableUpdates(view.state).length > 0;
          } catch {
            pending = false;
          }
        }
        if (!pending || !S.connected || Date.now() - t0 > ms) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  async function compile() {
    clearTimeout(S.autoTimer);
    if (S.compiling) {
      S.compileQueued = true;
      return;
    }
    S.compiling = true;
    E.compileBtn.disabled = true;
    E.compileBtn.replaceChildren(h("span", { class: "spinner" }), h("span", null, "Compiling…"));
    try {
      await waitForSync(3000);
      const r = await post(`/api/projects/${pid}/compile`);
      S.lastResult = r;
      renderLogs(r);
      if (r.pdf) {
        showPdf(r.pdf);
        if (r.status !== "success" && S.panel !== "logs") {
          const n = r.entries.filter((x) => x.level === "error").length;
          if (n) toast(`Compiled with ${n} error${n > 1 ? "s" : ""}. See the logs.`, "warn");
        }
      } else {
        showPanel("logs");
        if (r.status === "timeout") toast("Compilation timed out.", "error");
      }
    } catch (e) {
      toast(`Compile failed: ${e.message}`, "error");
    } finally {
      S.compiling = false;
      E.compileBtn.disabled = false;
      E.compileBtn.replaceChildren(icon("play"), h("span", null, "Recompile"));
      if (S.compileQueued) {
        S.compileQueued = false;
        compile();
      }
    }
  }

  function compileMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 2, [
      { label: (S.autoCompile ? "✓ " : "") + "Auto-compile while typing", action: () => { S.autoCompile = !S.autoCompile; saveLS("ul:autocompile", S.autoCompile); toast(`Auto-compile ${S.autoCompile ? "on" : "off"}`); } },
      S.canEdit ? { label: "Clear cached files", action: () => clearCache() } : null,
      { label: "Download log", action: () => window.open(`/api/projects/${pid}/output/output.log`, "_blank") },
    ]);
  }

  async function clearCache() {
    try {
      await post(`/api/projects/${pid}/clear-cache`);
      toast("Cached build files cleared", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function showPdf(url) {
    E.pdfLink.href = url;
    E.pdfDownload.href = url;
    E.pdfLink.classList.remove("hidden");
    E.pdfDownload.classList.remove("hidden");
    const old = [...E.pdfHost.children];
    const frame = h("iframe", { src: url, title: "PDF preview" });
    frame.style.visibility = "hidden";
    E.pdfHost.append(frame);
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      frame.style.visibility = "";
      old.forEach((o) => o.remove());
    };
    frame.addEventListener("load", swap, { once: true });
    setTimeout(swap, 2500);
    if (S.panel === "logs" && S.lastResult && S.lastResult.status === "success") showPanel("pdf");
  }

  function showPanel(which) {
    S.panel = which;
    E.logs.classList.toggle("hidden", which !== "logs");
    E.pdfHost.classList.toggle("hidden", which === "logs");
    E.logBtn.classList.toggle("primary", which === "logs");
  }

  function renderLogs(r) {
    const errors = r.entries.filter((x) => x.level === "error");
    const warnings = r.entries.filter((x) => x.level === "warning");
    const counts = E.logBtn.querySelector(".log-counts");
    counts.replaceChildren(
      errors.length ? h("span", { class: "c e" }, errors.length) : null,
      warnings.length ? h("span", { class: "c w" }, warnings.length) : null);
    const summary = {
      success: `Compiled successfully in ${(r.duration_ms / 1000).toFixed(1)} s`,
      error: `Compiled with errors (${errors.length})`,
      failure: "Compilation failed: no PDF was produced",
      timeout: "Compilation timed out",
    }[r.status] || r.status;
    const order = { error: 0, warning: 1, typesetting: 2 };
    const sorted = [...r.entries].sort((a, b) => order[a.level] - order[b.level]);
    E.logs.replaceChildren(
      h("div", { class: `log-summary ${r.status}` }, summary),
      sorted.length ? null : h("p", { class: "muted" }, "No errors or warnings."),
      sorted.map((x) => h("div", { class: `log-entry ${x.level}`, onclick: () => jumpTo(x, r) },
        h("div", { class: "log-head" },
          h("span", { class: "lvl" }, x.level),
          x.file || x.line ? h("span", { class: "loc" }, `${x.file || r.main || ""}${x.line ? ":" + x.line : ""}`) : null),
        h("div", { class: "log-msg" }, x.message),
        x.context ? h("pre", { class: "log-ctx" }, x.context) : null)),
      h("details", { class: "raw-log" }, h("summary", null, "Raw log"), h("pre", null, r.log || "(empty)")),
      r.stdout ? h("details", { class: "raw-log" }, h("summary", null, "latexmk output"), h("pre", null, r.stdout)) : null);
  }

  function jumpTo(entry, r) {
    const file = (entry.file || r.main || "").replace(/^\.\//, "");
    const id = S.pathToId.get(file);
    if (!id) {
      toast(`File "${file}" is not part of the project`, "warn");
      return;
    }
    if (S.openId === id && S.sync) {
      jumpToLine(entry.line);
    } else {
      S.pendingJump = { id, line: entry.line || 1 };
      openFile(id);
    }
  }

  function togglePreview() {
    const hidden = E.workspace.classList.toggle("no-pdf");
    saveLS("ul:hidePdf", hidden);
  }

  function setView(v) {
    E.workspace.dataset.view = v;
  }

  // ------------------------------------------------------------------ presence & chat
  function renderPresence() {
    const seen = new Set();
    const others = [];
    for (const u of S.presence) {
      if (u.conn === S.conn || seen.has(u.user_id)) continue;
      seen.add(u.user_id);
      others.push(u);
    }
    E.online.replaceChildren(...others.slice(0, 6).map((u) => {
      const where = u.doc && S.paths.get(u.doc) ? ` editing ${S.paths.get(u.doc)}` : "";
      return avatar(u, { title: u.name + where, style: { background: colorFor(u.user_id), cursor: u.doc ? "pointer" : "default" }, onclick: () => u.doc && openFile(u.doc) });
    }));
    if (others.length > 6) E.online.append(h("span", { class: "muted small", style: { marginLeft: "6px" } }, `+${others.length - 6}`));
    renderTree();
  }

  async function toggleChat() {
    S.chatOpen = !S.chatOpen;
    E.chat.classList.toggle("hidden", !S.chatOpen);
    if (!S.chatOpen) return;
    S.unread = 0;
    E.chatBadge.classList.add("hidden");
    if (!S.chatLoaded) {
      S.chatLoaded = true;
      try {
        const msgs = await get(`/api/projects/${pid}/chat`);
        E.chatList.replaceChildren(...msgs.map(chatEl));
      } catch (e) {
        toast(e.message, "error");
      }
    }
    E.chatList.scrollTop = E.chatList.scrollHeight;
    E.chatInput.focus();
  }

  function chatEl(m) {
    return h("div", { class: "chat-msg" },
      avatar({ user_id: m.user_id, name: m.name }),
      h("div", { class: "grow" },
        h("div", { class: "who" }, m.name, h("span", { class: "when" }, timeAgo(m.created_at))),
        h("div", { class: "body" }, m.body)));
  }

  function onChat(m) {
    if (S.chatLoaded) {
      const atBottom = E.chatList.scrollHeight - E.chatList.scrollTop - E.chatList.clientHeight < 40;
      E.chatList.append(chatEl(m));
      if (atBottom) E.chatList.scrollTop = E.chatList.scrollHeight;
    }
    if (!S.chatOpen) {
      S.unread++;
      E.chatBadge.textContent = S.unread;
      E.chatBadge.classList.remove("hidden");
    }
  }

  E.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const body = E.chatInput.value.trim();
      if (!body) return;
      if (socket.send({ t: "chat", body })) E.chatInput.value = "";
      else toast("Not connected", "error");
    }
  });

  // ------------------------------------------------------------------ dialogs
  async function renameProject() {
    if (!S.canEdit) return;
    const name = await promptDialog("Rename project", { value: S.project.name, okText: "Rename", selectStem: false });
    if (!name || name === S.project.name) return;
    try {
      await patch(`/api/projects/${pid}`, { name });
      S.project.name = name;
      E.pname.textContent = name;
      document.title = `${name} - Underleaf`;
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function shareDialog() {
    const isOwner = S.role === "owner";
    const list = h("div");
    const draw = () => {
      list.replaceChildren(...S.project.members.map((m) => h("div", { class: "member" },
        avatar({ id: m.id, display_name: m.display_name }),
        h("div", { class: "grow" }, h("div", null, m.display_name, m.id === ctx.me.id ? h("span", { class: "muted" }, " (you)") : null), h("div", { class: "muted small" }, "@" + m.username)),
        isOwner && m.role !== "owner"
          ? [
            (() => {
              const sel = h("select", { onchange: () => addMember(m.username, sel.value) },
                h("option", { value: "editor" }, "Can edit"),
                h("option", { value: "viewer" }, "Can view"));
              sel.value = m.role;
              return sel;
            })(),
            h("button", { class: "icon-btn", title: "Remove", onclick: () => removeMember(m) }, icon("close")),
          ]
          : h("span", { class: `role-badge ${m.role}` }, m.role))));
    };
    const uname = h("input", { type: "text", placeholder: "Username" });
    const role = h("select", null, h("option", { value: "editor" }, "Can edit"), h("option", { value: "viewer" }, "Can view"));
    const err = h("div", { class: "form-error" });
    async function addMember(username, r) {
      err.textContent = "";
      try {
        await post(`/api/projects/${pid}/members`, { username, role: r });
        uname.value = "";
        await refreshProject();
        draw();
      } catch (e) {
        err.textContent = e.message;
      }
    }
    async function removeMember(m) {
      try {
        await del(`/api/projects/${pid}/members/${m.id}`);
        await refreshProject();
        draw();
      } catch (e) {
        err.textContent = e.message;
      }
    }
    draw();
    const body = h("div", null,
      list,
      isOwner
        ? h("form", { class: "share-form", onsubmit: (e) => { e.preventDefault(); if (uname.value.trim()) addMember(uname.value.trim(), role.value); } },
          uname, role, h("button", { class: "btn primary", type: "submit" }, "Share"))
        : h("p", { class: "muted small" }, "Only the owner can add or remove collaborators."),
      err);
    const actions = [];
    if (!isOwner) {
      actions.push(h("button", {
        class: "btn danger",
        onclick: async () => {
          if (!(await confirmDialog("Leave project", "Stop collaborating on this project?", { okText: "Leave", danger: true }))) return;
          try {
            await del(`/api/projects/${pid}/members/${ctx.me.id}`);
            m.close();
            ctx.navigate("/");
          } catch (e) {
            toast(e.message, "error");
          }
        },
      }, "Leave project"));
    }
    const m = modal({ title: "Share project", body, actions });
  }

  function settingsDialog() {
    const compiler = h("select", { disabled: !S.canEdit },
      h("option", { value: "pdflatex" }, "pdfLaTeX"),
      h("option", { value: "xelatex" }, "XeLaTeX"),
      h("option", { value: "lualatex" }, "LuaLaTeX"));
    compiler.value = S.project.compiler;
    const docs = S.tree.filter((e) => e.kind === "doc" && /\.tex$/i.test(e.name)).sort((a, b) => S.paths.get(a.id).localeCompare(S.paths.get(b.id)));
    const main = h("select", { disabled: !S.canEdit },
      h("option", { value: "" }, "(auto-detect)"),
      docs.map((d) => h("option", { value: d.id }, S.paths.get(d.id))));
    main.value = S.project.main_file || "";
    const err = h("div", { class: "form-error" });
    const save = async () => {
      try {
        await patch(`/api/projects/${pid}`, { compiler: compiler.value, main_file: main.value });
        S.project.compiler = compiler.value;
        S.project.main_file = main.value || null;
        renderTree();
        m.close();
        toast("Settings saved", "success");
      } catch (e) {
        err.textContent = e.message;
      }
    };
    const m = modal({
      title: "Project settings",
      body: h("div", { class: "form" },
        h("label", null, "Compiler"), compiler,
        h("label", null, "Main document"), main,
        h("p", { class: "muted small" }, "Ctrl+S or Ctrl+Enter recompiles. Builds run with latexmk; shell escape is disabled."),
        err),
      actions: S.canEdit
        ? [h("button", { class: "btn", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onclick: save }, "Save")]
        : [h("button", { class: "btn", onclick: () => m.close() }, "Close")],
    });
  }

  // ------------------------------------------------------------------ socket
  const socket = new ProjectSocket(pid, onMessage, onSocketState);

  function onMessage(m) {
    if (S.destroyed) return;
    switch (m.t) {
      case "hello":
        S.conn = m.conn;
        break;
      case "doc":
        onDocMessage(m);
        break;
      case "updates":
        if (m.doc === S.openId && S.sync) {
          const c = S.sync.controller();
          if (c) c.receive(m.version, m.updates);
        }
        break;
      case "nack":
        if (m.doc === S.openId && S.sync) {
          const c = S.sync.controller();
          if (c) c.nack(m.version);
        }
        break;
      case "resync":
        if (m.doc === S.openId) {
          if (S.sync) S.keepSelection = { id: m.doc, pos: view.state.selection.main.head };
          socket.send({ t: "open", doc: m.doc });
        }
        break;
      case "cursor":
        if (m.doc === S.openId && S.sync && m.conn !== S.conn) {
          view.dispatch({ effects: setRemoteCursor.of({ conn: m.conn, anchor: m.anchor, head: m.head, name: m.name, color: colorFor(m.user_id) }) });
        }
        break;
      case "cursor_clear":
        if (m.doc === S.openId && S.sync) view.dispatch({ effects: removeRemoteCursor.of(m.conn) });
        break;
      case "presence":
        S.presence = m.users || [];
        renderPresence();
        break;
      case "tree":
        refreshTree();
        break;
      case "project":
        refreshProject();
        break;
      case "deleted":
        if (m.doc === S.openId) {
          S.openId = null;
          showPlaceholder("This file was deleted.");
        }
        break;
      case "chat":
        onChat(m.msg);
        break;
      case "task_assigned":
        taskNotice(m, ctx.me);
        break;
      case "project_deleted":
        projectGone();
        break;
      case "error":
        toast(m.message || "Server error", "error");
        if (m.doc && m.doc === S.openId) E.loading.classList.add("hidden");
        break;
      default:
        break;
    }
  }

  function onSocketState(state) {
    if (S.destroyed) return;
    S.connected = state === "open";
    E.connDot.classList.toggle("off", !S.connected);
    E.connDot.title = S.connected ? "Connected" : "Disconnected, reconnecting…";
    if (state === "open") {
      if (!S.everConnected) {
        S.everConnected = true;
        const last = loadLS(`ul:open:${pid}`, null);
        const first =
          (last && S.byId.has(last) && last) ||
          (S.project.main_file && S.byId.has(S.project.main_file) && S.project.main_file) ||
          (S.tree.find((e) => e.kind === "doc" && /\.tex$/i.test(e.name)) || {}).id;
        if (first) openFile(first);
      } else {
        refreshProject();
        const c = S.sync && S.sync.controller();
        if (S.openId && c) c.reconnected();
        else if (S.openId && S.byId.get(S.openId) && S.byId.get(S.openId).kind === "doc") socket.send({ t: "open", doc: S.openId });
      }
    } else {
      if (S.sync) setSaveState("offline");
      // Find out whether we were removed from the project.
      get(`/api/projects/${pid}`).catch((e) => {
        if (e.status === 404) projectGone();
      });
    }
  }

  // ------------------------------------------------------------------ global keys
  const onKey = (e) => {
    if (e.defaultPrevented) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "Enter")) {
      e.preventDefault();
      compile();
    }
  };
  window.addEventListener("keydown", onKey);
  cleanups.push(() => window.removeEventListener("keydown", onKey));

  const onBeforeUnload = (e) => {
    const c = S.sync && S.sync.controller();
    if (c && c.hasPending()) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  cleanups.push(() => window.removeEventListener("beforeunload", onBeforeUnload));

  // ------------------------------------------------------------------ init
  document.title = `${project.name} - Underleaf`;
  indexTree();
  renderTree();
  showPanel("pdf");

  // Show the last PDF if one exists.
  fetch(`/api/projects/${pid}/output/output.pdf`, { method: "HEAD", credentials: "same-origin" })
    .then((r) => {
      if (r.ok && !S.lastResult) showPdf(`/api/projects/${pid}/output/output.pdf?v=${Date.now()}`);
    })
    .catch(() => {});

  return {
    destroy() {
      S.destroyed = true;
      clearTimeout(S.autoTimer);
      clearTimeout(S.cursorTimer);
      clearTimeout(treeTimer);
      socket.close();
      view.destroy();
      cleanups.forEach((f) => f());
      document.querySelectorAll(".ctx-menu, .modal-overlay").forEach((x) => x.remove());
    },
  };
}

function splitter(el, onMove) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("active");
    document.body.classList.add("resizing");
    const move = (ev) => onMove(ev.clientX);
    const up = () => {
      el.classList.remove("active");
      document.body.classList.remove("resizing");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}
