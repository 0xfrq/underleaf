// The issue view (title, description, details, comments, history) and the "Create issue" dialog.

import { get, post, patch, del } from "./api.js";
import { h, icon, toast, modal, confirmDialog, avatar, timeAgo } from "./ui.js";
import {
  KINDS, PRIORITIES, STATUSES, options, setSelect, kindIcon, priorityIcon, statusPicker, statusPill,
  assigneeAvatar, richText, activityText, epicChip, boardContext,
} from "./tasks-common.js";

const commentDrafts = new Map(); // unsent comments, per issue id

/** Grow a textarea to fit its content. */
function autosize(ta) {
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + 2 + "px";
  };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
}

/**
 * Open an issue in a modal.
 *   onChange(task)      after every saved change
 *   onChange(null, id)  after the issue was deleted
 *   onShow(task)        whenever an issue is displayed (the dialog can navigate to epics/children)
 * Returns { id, close(), refresh() }.
 */
export function openTask({ pid, id, me, onChange = () => {}, onShow = () => {}, onClose }) {
  let D = null; // the server's view of the issue
  let tab = "comments";
  let built = null; // id of the issue the main column was built for
  let closed = false;
  let descDraft = null; // text while the description is being edited

  const head = h("span", { class: "issue-head" });
  const main = h("div", { class: "issue-main" }, h("div", { class: "issue-loading" }, h("span", { class: "spinner" })));
  const side = h("aside", { class: "issue-side" });
  const E = {};

  const m = modal({
    title: head,
    body: h("div", { class: "issue-grid" }, main, side),
    wide: true,
    onClose: () => {
      closed = true;
      if (D && descDraft != null && descDraft.trim() !== D.task.description) {
        // Do not lose an unsaved description.
        patch(`/api/projects/${pid}/tasks/${D.task.id}`, { description: descDraft })
          .then((t) => onChange(t))
          .catch((e) => toast(`Description not saved: ${e.message}`, "error"));
      }
      if (onClose) onClose();
    },
  });
  m.el.classList.add("issue");

  const canEdit = () => D.project.role !== "viewer";
  const canMove = () => canEdit() || D.task.assignee_id === me.id;
  const keyOf = (t) => `${D.project.key}-${t.num}`;

  async function load() {
    const want = id;
    let d;
    try {
      d = await get(`/api/projects/${pid}/tasks/${want}`);
    } catch (e) {
      if (closed || want !== id) return;
      built = null;
      main.replaceChildren(h("div", { class: "placeholder" }, e.status === 404 ? "This issue does not exist or was deleted." : e.message));
      side.replaceChildren();
      head.replaceChildren();
      return;
    }
    if (closed || want !== id) return;
    D = d;
    render();
    onShow(D.task);
  }

  function switchTo(tid) {
    if (descDraft != null) return toast("Save or cancel the description first", "warn");
    id = tid;
    built = null;
    main.replaceChildren(h("div", { class: "issue-loading" }, h("span", { class: "spinner" })));
    load();
  }

  async function save(body) {
    const tid = D.task.id;
    try {
      const t = await patch(`/api/projects/${pid}/tasks/${tid}`, body);
      if (closed || !D || D.task.id !== tid) return onChange(t);
      D.task = { ...t, description: "description" in body ? body.description.replace(/\r\n?/g, "\n").trim() : D.task.description };
      renderHead();
      renderSide();
      onChange(t);
      refresh();
    } catch (e) {
      toast(e.message, "error");
      refresh();
    }
  }

  async function refresh() {
    if (!closed) await load();
  }

  // ------------------------------------------------------------------ render
  function render() {
    if (built !== D.task.id) {
      buildMain();
      built = D.task.id;
    } else {
      renderTitle();
      if (descDraft == null) renderDesc();
      renderChildren();
      renderActivity();
    }
    renderHead();
    renderSide();
  }

  function renderHead() {
    const t = D.task;
    const epic = t.parent_id ? D.epics.find((e) => e.id === t.parent_id) : null;
    head.replaceChildren(...[
      epic ? h("button", { class: "crumb", title: epic.title, onclick: () => switchTo(epic.id) }, kindIcon("epic"), keyOf(epic)) : null,
      epic ? h("span", { class: "muted" }, "/") : null,
      h("span", { class: "crumb static" }, kindIcon(t.kind), keyOf(t)),
    ].filter(Boolean));
  }

  function buildMain() {
    E.title = h("div", { class: "issue-title-wrap" });
    E.desc = h("section", { class: "issue-section" });
    E.children = h("section", { class: "issue-section" });
    E.activity = h("section", { class: "issue-section" });
    E.list = h("div", { class: "activity-list" });
    E.tabs = h("div", { class: "seg" });
    E.composer = null;
    descDraft = null;
    renderTitle();
    renderDesc();
    renderChildren();
    buildComposer(); // every member can comment, viewers included
    E.activity.replaceChildren(h("div", { class: "section-head" }, h("h4", null, "Activity"), h("div", { class: "spacer" }), E.tabs), E.composer, E.list);
    renderActivity();
    main.replaceChildren(E.title, E.desc, E.children, E.activity);
  }

  function renderTitle() {
    const t = D.task;
    if (E.title.contains(document.activeElement)) return;
    if (!canEdit()) {
      E.title.replaceChildren(h("h2", { class: "issue-title ro" }, t.title));
      return;
    }
    const ta = h("textarea", { class: "issue-title", rows: 1, maxlength: 255, "aria-label": "Summary" });
    ta.value = t.title;
    const commit = () => {
      const v = ta.value.replace(/\s+/g, " ").trim();
      if (!v) ta.value = D.task.title;
      else if (v !== D.task.title) save({ title: v });
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        ta.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ta.value = D.task.title;
        ta.blur();
      }
    });
    ta.addEventListener("blur", commit);
    autosize(ta);
    E.title.replaceChildren(ta);
  }

  function renderDesc() {
    const t = D.task;
    const headRow = h("div", { class: "section-head" }, h("h4", null, "Description"));
    if (descDraft != null) {
      const ta = h("textarea", { class: "desc-edit", rows: 6, placeholder: "Describe the work. Links are clickable." });
      ta.value = descDraft;
      ta.addEventListener("input", () => (descDraft = ta.value));
      const finish = (saveIt) => {
        const v = descDraft;
        descDraft = null;
        renderDesc();
        if (saveIt && v.trim() !== t.description) save({ description: v });
      };
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(true);
        }
      });
      autosize(ta);
      E.desc.replaceChildren(headRow, ta, h("div", { class: "row", style: { marginTop: "8px" } },
        h("button", { class: "btn primary sm", onclick: () => finish(true) }, "Save"),
        h("button", { class: "btn sm", onclick: () => finish(false) }, "Cancel"),
        h("span", { class: "muted small" }, "Ctrl+Enter to save")));
      setTimeout(() => ta.focus(), 0);
      return;
    }
    const startEdit = () => {
      descDraft = t.description;
      renderDesc();
    };
    const view = t.description
      ? h("div", { class: "desc-view" + (canEdit() ? " editable" : ""), title: canEdit() ? "Click to edit" : null }, richText(t.description))
      : h("div", { class: "desc-view empty" + (canEdit() ? " editable" : "") }, canEdit() ? "Add a description…" : "No description.");
    if (canEdit()) {
      // Clicking a link inside the description opens it instead of the editor.
      view.addEventListener("click", (e) => {
        if (!e.target.closest("a")) startEdit();
      });
    }
    E.desc.replaceChildren(headRow, view);
  }

  function renderChildren() {
    const t = D.task;
    if (t.kind !== "epic") {
      E.children.replaceChildren();
      E.children.classList.add("hidden");
      return;
    }
    E.children.classList.remove("hidden");
    const kids = D.children;
    const done = kids.filter((k) => k.status === "done").length;
    const pct = kids.length ? Math.round((done / kids.length) * 100) : 0;
    E.children.replaceChildren(...[
      h("div", { class: "section-head" },
        h("h4", null, "Child issues"),
        kids.length ? h("span", { class: "muted small" }, `${done} of ${kids.length} done`) : null,
        h("div", { class: "spacer" }),
        canEdit() ? h("button", { class: "btn sm", onclick: () => addChild() }, icon("plus"), "Add child issue") : null),
      kids.length ? h("div", { class: "progress", title: `${pct}% done` }, h("span", { style: { width: pct + "%" } })) : null,
      kids.length
        ? h("div", { class: "child-list" }, kids.map((k) => h("div", { class: "child-row" + (k.status === "done" ? " done" : ""), onclick: () => switchTo(k.id) },
          kindIcon(k.kind), h("span", { class: "card-key" }, keyOf(k)), h("span", { class: "grow ellipsis" }, k.title),
          priorityIcon(k.priority), statusPill(k.status), assigneeAvatar(k))))
        : h("p", { class: "muted small" }, "No child issues yet. Issues linked to this epic appear here."),
    ].filter(Boolean));
  }

  function addChild() {
    const epic = D.task;
    openCreate({
      pid,
      data: { project: D.project, members: D.members, sprints: D.sprints, epics: D.epics },
      defaults: { parent_id: epic.id },
      me,
      onCreated: (t) => {
        onChange(t);
        if (!closed && D.task.id === epic.id) refresh();
      },
    });
  }

  function buildComposer() {
    const tid = D.task.id;
    const ta = h("textarea", { class: "composer", rows: 2, placeholder: "Add a comment…" });
    ta.value = commentDrafts.get(tid) || "";
    const send = h("button", { class: "btn primary sm" }, "Save");
    const bar = h("div", { class: "row composer-bar" + (ta.value ? "" : " hidden") }, send, h("span", { class: "muted small" }, "Ctrl+Enter to save"));
    ta.addEventListener("focus", () => bar.classList.remove("hidden"));
    ta.addEventListener("input", () => commentDrafts.set(tid, ta.value));
    const submit = async () => {
      const body = ta.value.trim();
      if (!body) return;
      send.disabled = true;
      try {
        const c = await post(`/api/projects/${pid}/tasks/${tid}/comments`, { body });
        commentDrafts.delete(tid);
        ta.value = "";
        bar.classList.add("hidden");
        if (D && D.task.id === tid) {
          D.comments.push(c);
          D.task.comments = D.comments.length;
          tab = "comments";
          renderActivity();
          onChange(D.task);
        }
      } catch (e) {
        toast(e.message, "error");
      } finally {
        send.disabled = false;
      }
    };
    send.addEventListener("click", submit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    });
    autosize(ta);
    E.composer = h("div", { class: "composer-wrap" }, avatar({ id: me.id, display_name: me.display_name }), h("div", { class: "grow" }, ta, bar));
  }

  function renderActivity() {
    E.tabs.replaceChildren(
      h("button", { class: "btn sm" + (tab === "comments" ? " on" : ""), onclick: () => { tab = "comments"; renderActivity(); } }, `Comments (${D.comments.length})`),
      h("button", { class: "btn sm" + (tab === "history" ? " on" : ""), onclick: () => { tab = "history"; renderActivity(); } }, "History"));
    if (E.composer) E.composer.classList.toggle("hidden", tab !== "comments");
    if (tab === "comments") {
      const list = [...D.comments].reverse(); // newest first, like Jira
      E.list.replaceChildren(...(list.length ? list.map(commentEl) : [h("p", { class: "muted small" }, "No comments yet.")]));
    } else {
      E.list.replaceChildren(...D.activity.map((a) => h("div", { class: "act" },
        avatar({ id: a.user_id || 0, display_name: a.name || "?" }),
        h("div", { class: "grow" }, activityText(a), h("div", { class: "muted small" }, timeAgo(a.created_at))))));
    }
  }

  function commentEl(c) {
    const mine = c.user_id === me.id;
    const canDelete = mine || D.project.role === "owner";
    const body = h("div", { class: "comment-body" }, richText(c.body));
    const actions = h("div", { class: "comment-actions" },
      mine ? h("button", { class: "linkish", onclick: () => editComment(c, body, actions) }, "Edit") : null,
      canDelete ? h("button", { class: "linkish", onclick: () => deleteComment(c) }, "Delete") : null);
    return h("div", { class: "comment" },
      avatar({ id: c.user_id, display_name: c.name }),
      h("div", { class: "grow" },
        h("div", { class: "comment-meta" }, h("strong", null, c.name), h("span", { class: "muted small" }, timeAgo(c.created_at), c.edited_at ? " · edited" : "")),
        body,
        actions));
  }

  function editComment(c, body, actions) {
    const ta = h("textarea", { rows: 3 });
    ta.value = c.body;
    const tid = D.task.id;
    const done = async (saveIt) => {
      if (saveIt && ta.value.trim() && ta.value.trim() !== c.body) {
        try {
          const nc = await patch(`/api/projects/${pid}/tasks/${tid}/comments/${c.id}`, { body: ta.value });
          Object.assign(c, nc);
        } catch (e) {
          return toast(e.message, "error");
        }
      }
      renderActivity();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        done(true);
      }
    });
    body.replaceChildren(ta);
    actions.replaceChildren(h("button", { class: "btn primary sm", onclick: () => done(true) }, "Save"), h("button", { class: "btn sm", onclick: () => done(false) }, "Cancel"));
    autosize(ta);
    ta.focus();
  }

  async function deleteComment(c) {
    if (!(await confirmDialog("Delete comment", "Delete this comment? This cannot be undone.", { okText: "Delete", danger: true }))) return;
    try {
      await del(`/api/projects/${pid}/tasks/${D.task.id}/comments/${c.id}`);
      D.comments = D.comments.filter((x) => x.id !== c.id);
      D.task.comments = D.comments.length;
      renderActivity();
      onChange(D.task);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // ------------------------------------------------------------------ details panel
  function renderSide() {
    // Don't throw away what the user is typing in a field.
    const ae = document.activeElement;
    if (ae && side.contains(ae) && ae.tagName === "INPUT") return;
    const t = D.task;
    const ed = canEdit();
    const field = (label, ...control) => h("div", { class: "field" }, h("label", null, label), h("div", { class: "field-ctl" }, control));
    const select = (opts, value, onPick) => {
      const s = h("select", { disabled: !ed, onchange: () => onPick(s.value) }, opts);
      setSelect(s, value);
      return s;
    };

    const status = statusPicker(t.status, canMove(), (s) => save({ status: s }));
    status.classList.add("big");

    const assignee = select(
      [h("option", { value: "" }, "Unassigned"), D.members.map((u) => h("option", { value: u.id }, u.display_name))],
      t.assignee_id ?? "",
      (v) => save({ assignee_id: v ? Number(v) : null }));
    const sprintOpts = D.sprints.filter((s) => s.state !== "closed" || s.id === t.sprint_id);
    const sprint = select(
      [h("option", { value: "" }, "Backlog"), sprintOpts.map((s) => h("option", { value: s.id }, s.name + (s.state === "active" ? " (active)" : s.state === "closed" ? " (completed)" : "")))],
      t.sprint_id ?? "",
      (v) => save({ sprint_id: v ? Number(v) : null }));
    const epic = select(
      [h("option", { value: "" }, "None"), D.epics.filter((e) => e.id !== t.id).map((e) => h("option", { value: e.id }, `${keyOf(e)} ${e.title}`))],
      t.parent_id ?? "",
      (v) => save({ parent_id: v ? Number(v) : null }));

    const labels = h("input", { type: "text", disabled: !ed, placeholder: ed ? "Add labels, comma separated" : "None" });
    labels.value = t.labels.join(", ");
    labels.addEventListener("change", () => save({ labels: labels.value.split(",") }));
    labels.addEventListener("keydown", (e) => e.key === "Enter" && labels.blur());

    const dateInput = (value, onPick) => {
      const i = h("input", { type: "date", disabled: !ed });
      i.value = value || "";
      i.addEventListener("change", () => onPick(i.value || null));
      return i;
    };
    const start = dateInput(t.start_date, (v) => save({ start_date: v }));
    const due = dateInput(t.due_date, (v) => save({ due_date: v }));
    const pts = h("input", { type: "number", min: 0, max: 999, step: 1, disabled: !ed, placeholder: "None" });
    pts.value = t.estimate ?? "";
    pts.addEventListener("change", () => save({ estimate: pts.value === "" ? null : Math.max(0, Math.min(999, Math.round(Number(pts.value)))) }));

    const linkBtn = h("button", { class: "btn sm", onclick: copyLink }, icon("link"), "Copy link");

    side.replaceChildren(
      h("div", { class: "side-status" }, status,
        canMove() && t.status !== "done" ? h("button", { class: "btn sm", title: "Move to Done", onclick: () => save({ status: "done" }) }, icon("check"), "Done") : null),
      h("div", { class: "fields" },
        field("Assignee", t.assignee_id ? assigneeAvatar(t) : null, assignee),
        ed && t.assignee_id !== me.id && D.members.some((u) => u.id === me.id)
          ? h("button", { class: "linkish assign-me", onclick: () => save({ assignee_id: me.id }) }, "Assign to me")
          : null,
        field("Reporter", t.reporter_id ? avatar({ id: t.reporter_id, display_name: t.reporter_name || "?" }) : null, h("span", { class: "static" }, t.reporter_name || "Former user")),
        field("Priority", priorityIcon(t.priority), select(options(PRIORITIES), t.priority, (v) => save({ priority: v }))),
        field("Type", kindIcon(t.kind), select(options(KINDS), t.kind, (v) => save({ kind: v }))),
        field("Sprint", sprint),
        t.kind !== "epic" ? field("Epic", epic) : null,
        field("Labels", labels),
        field("Start date", start),
        field("Due date", due),
        field("Story points", pts)),
      h("div", { class: "issue-meta muted small" },
        h("div", null, `Created ${timeAgo(t.created_at)}`),
        h("div", null, `Updated ${timeAgo(t.updated_at)}`),
        t.resolved_at ? h("div", null, `Resolved ${timeAgo(t.resolved_at)}`) : null),
      h("div", { class: "row side-actions" },
        linkBtn,
        ed ? h("button", { class: "btn sm danger", onclick: removeTask }, icon("trash"), "Delete") : null),
    );
  }

  async function copyLink() {
    const url = `${location.origin}/project/${pid}/board?task=${D.task.num}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied", "success");
    } catch {
      // Clipboard access needs a secure context; show the link instead.
      toast(url, "info", 8000);
    }
  }

  async function removeTask() {
    const t = D.task;
    const extra = t.kind === "epic" && D.children.length ? ` Its ${D.children.length} child issue(s) will be kept without an epic.` : "";
    if (!(await confirmDialog("Delete issue", `Delete ${keyOf(t)} "${t.title}"? Comments and history are deleted too.${extra}`, { okText: "Delete", danger: true }))) return;
    try {
      await del(`/api/projects/${pid}/tasks/${t.id}`);
      descDraft = null;
      m.close();
      toast(`${keyOf(t)} deleted`, "success");
      onChange(null, t.id);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  load();
  return {
    get id() {
      return id;
    },
    close: () => m.close(),
    refresh,
  };
}

// ---------------------------------------------------------------------------

/**
 * The "Create issue" dialog.
 *   pid + data   a fixed project; data = { project, members, sprints, epics }
 *   projects     [{ id, name, role }] to choose from instead (data is fetched per project)
 *   defaults     initial field values (status, sprint_id, parent_id, due_date, assignee_id, ...)
 *   onCreated(task, pid)
 */
export function openCreate({ pid, data, projects, defaults = {}, me, onCreated = () => {} }) {
  const cache = new Map();
  if (pid && data) cache.set(pid, data);
  const writable = (projects || []).filter((p) => p.role !== "viewer");
  const err = h("div", { class: "form-error" });

  const projectSel = projects ? h("select", { onchange: () => useProject(projectSel.value) }, writable.map((p) => h("option", { value: p.id }, p.name))) : null;
  if (projectSel) setSelect(projectSel, pid || "");
  const kind = h("select", { onchange: () => parentRow.classList.toggle("hidden", kind.value === "epic") }, options(KINDS));
  setSelect(kind, defaults.kind || "task");
  const title = h("input", { type: "text", maxlength: 255, placeholder: "What needs to be done?" });
  const desc = h("textarea", { rows: 4, placeholder: "Add more detail (optional)" });
  const status = h("select", null, options(STATUSES));
  setSelect(status, defaults.status || "todo");
  const priority = h("select", null, options(PRIORITIES));
  setSelect(priority, defaults.priority || "medium");
  const assignee = h("select");
  const parent = h("select");
  const sprint = h("select");
  const labels = h("input", { type: "text", placeholder: "e.g. figures, chapter-2" });
  const start = h("input", { type: "date" });
  start.value = defaults.start_date || "";
  const due = h("input", { type: "date" });
  due.value = defaults.due_date || "";
  const pts = h("input", { type: "number", min: 0, max: 999, step: 1, placeholder: "–" });
  const another = h("input", { type: "checkbox" });

  const cell = (label, control) => h("div", null, h("label", null, label), control);
  const parentRow = cell("Epic", parent);
  parentRow.classList.toggle("hidden", kind.value === "epic");

  function fill(d) {
    assignee.replaceChildren(h("option", { value: "" }, "Unassigned"), d.members.map((u) => h("option", { value: u.id }, u.display_name + (u.id === me.id ? " (me)" : ""))));
    setSelect(assignee, defaults.assignee_id ?? "");
    parent.replaceChildren(h("option", { value: "" }, "None"), d.epics.map((e) => h("option", { value: e.id }, `${d.project.key}-${e.num} ${e.title}`)));
    setSelect(parent, defaults.parent_id ?? "");
    sprint.replaceChildren(h("option", { value: "" }, "Backlog"), d.sprints.filter((s) => s.state !== "closed").map((s) => h("option", { value: s.id }, s.name + (s.state === "active" ? " (active)" : ""))));
    setSelect(sprint, defaults.sprint_id ?? "");
  }

  async function useProject(p) {
    if (!p) return;
    err.textContent = "";
    if (!cache.has(p)) {
      try {
        cache.set(p, boardContext(await get(`/api/projects/${p}/tasks`)));
      } catch (e) {
        err.textContent = e.message;
        return;
      }
    }
    if (currentPid() === p) fill(cache.get(p));
  }

  const currentPid = () => (projectSel ? projectSel.value : pid);

  const createBtn = h("button", { class: "btn primary", onclick: () => submit() }, "Create");
  async function submit() {
    err.textContent = "";
    const p = currentPid();
    const d = p && cache.get(p);
    if (!d) {
      err.textContent = projects && !writable.length ? "You need edit access to a project to create issues." : "Choose a project";
      return;
    }
    const body = {
      title: title.value.trim(),
      kind: kind.value,
      status: status.value,
      priority: priority.value,
      description: desc.value,
      labels: labels.value.split(","),
      assignee_id: assignee.value ? Number(assignee.value) : null,
      sprint_id: sprint.value ? Number(sprint.value) : null,
      parent_id: kind.value !== "epic" && parent.value ? Number(parent.value) : null,
      start_date: start.value || null,
      due_date: due.value || null,
      estimate: pts.value === "" ? null : Math.max(0, Math.min(999, Math.round(Number(pts.value)))),
    };
    if (!body.title) {
      err.textContent = "Please enter a summary";
      title.focus();
      return;
    }
    createBtn.disabled = true;
    try {
      const t = await post(`/api/projects/${p}/tasks`, body);
      toast(`Created ${d.project.key}-${t.num}`, "success");
      if (t.kind === "epic") d.epics.push(t);
      onCreated(t, p);
      if (another.checked) {
        title.value = "";
        desc.value = "";
        if (t.kind === "epic") fill(d);
        title.focus();
      } else {
        m.close();
      }
    } catch (e) {
      err.textContent = e.message;
    } finally {
      createBtn.disabled = false;
    }
  }

  const onEnter = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.target === title)) {
      e.preventDefault();
      submit();
    }
  };
  title.addEventListener("keydown", onEnter);
  desc.addEventListener("keydown", onEnter);

  const body = h("div", { class: "form create-form" },
    h("div", { class: "grid2" }, projectSel ? cell("Project", projectSel) : null, cell("Issue type", kind)),
    h("label", null, "Summary"), title,
    h("label", null, "Description"), desc,
    h("div", { class: "grid2" },
      cell("Status", status),
      cell("Priority", priority),
      cell("Assignee", assignee),
      parentRow,
      cell("Sprint", sprint),
      cell("Story points", pts),
      cell("Start date", start),
      cell("Due date", due)),
    h("label", null, "Labels"), labels,
    err);

  const m = modal({
    title: "Create issue",
    wide: true,
    body,
    actions: [
      h("label", { class: "row create-another" }, another, "Create another"),
      h("button", { class: "btn", onclick: () => m.close() }, "Cancel"),
      createBtn,
    ],
  });
  setTimeout(() => title.focus(), 0);

  if (currentPid()) useProject(currentPid());
  return m;
}
