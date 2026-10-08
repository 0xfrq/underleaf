// The task tracker of a project: summary, board, backlog, list, calendar and timeline views.
// Issues belong to a project and can be assigned to its members; changes arrive live over the
// project's WebSocket, the same one the editor uses.

import { get, post, patch, del } from "./api.js";
import { h, icon, toast, modal, confirmDialog, contextMenu, avatar, colorFor, timeAgo, loadLS, saveLS } from "./ui.js";
import { ProjectSocket } from "./collab.js";
import { userMenuButton } from "./dashboard.js";
import {
  STATUSES, KINDS, PRIORITIES, STATUS_RANK, KIND_RANK, PRIORITY_RANK, setSelect, kindIcon, priorityIcon,
  statusPicker, assigneeAvatar, epicChip, labelChips, points, dueBadge, isOverdue, today, addDays,
  dayDiff, parseDate, fmtDate, sprintDates, sprintRemaining, activityText, taskNotice, kindLabel, statusLabel,
  priorityLabel,
} from "./tasks-common.js";
import { openTask, openCreate } from "./task-dialog.js";
import { taskCalendar } from "./task-calendar.js";

export const VIEWS = [
  { id: "summary", label: "Summary", icon: "chart" },
  { id: "board", label: "Board", icon: "board" },
  { id: "backlog", label: "Backlog", icon: "backlog" },
  { id: "list", label: "List", icon: "list" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "timeline", label: "Timeline", icon: "timeline" },
];
const VIEW_RE = new RegExp(`^/project/([0-9a-f]+)/(${VIEWS.map((v) => v.id).join("|")})/?$`);

/** Matches /project/<id>/<view>; returns [pid, view] or null. */
export function matchTasksPath(path) {
  const m = path.match(VIEW_RE);
  return m ? [m[1], m[2]] : null;
}

const DONE_VISIBLE_SECS = 14 * 86400; // the board hides issues finished longer ago than this

export async function openTasks(root, pid, view, ctx) {
  const me = ctx.me;
  const S = {
    view,
    data: null,
    byId: new Map(),
    key: "",
    canEdit: false,
    version: 0,
    filter: { q: "", mine: false, assignees: new Set(), kind: "", epic: "", label: "", status: "" },
    scope: loadLS(`ul:board-scope:${pid}`, "sprint"),
    collapsed: new Set(loadLS(`ul:bl-collapsed:${pid}`, [])),
    sort: { col: "key", dir: -1 },
    quick: null, // open inline "create issue" form: { where, text, kind }
    dialog: null,
    dragging: null,
    pendingReload: false,
    reloadTimer: null,
    presence: [],
    conn: null,
    destroyed: false,
    filterSig: "",
  };

  async function load() {
    const d = await get(`/api/projects/${pid}/tasks`);
    S.data = d;
    S.key = d.project.key;
    S.canEdit = d.project.role !== "viewer";
    S.byId = new Map(d.tasks.map((t) => [t.id, t]));
    S.version++;
  }
  await load();

  // ------------------------------------------------------------------ helpers
  const keyOf = (t) => `${S.key}-${t.num}`;
  const canMove = (t) => S.canEdit || t.assignee_id === me.id;
  const sprintOf = (id) => (id == null ? null : S.data.sprints.find((s) => s.id === id));
  const activeSprint = () => S.data.sprints.find((s) => s.state === "active");
  const epics = () => S.data.tasks.filter((t) => t.kind === "epic");
  const sortTasks = () => S.data.tasks.sort((a, b) => a.sort_key - b.sort_key || a.id - b.id);
  const context = () => ({ project: S.data.project, members: S.data.members, sprints: S.data.sprints, epics: epics() });
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function passes(t) {
    const f = S.filter;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (!t.title.toLowerCase().includes(q) && !keyOf(t).toLowerCase().includes(q) && !t.labels.some((l) => l.toLowerCase().includes(q))) return false;
    }
    if (f.mine && t.assignee_id !== me.id) return false;
    if (f.assignees.size && !f.assignees.has(t.assignee_id ?? 0)) return false;
    if (f.kind && t.kind !== f.kind) return false;
    if (f.epic && (f.epic === "none" ? t.parent_id != null : String(t.parent_id) !== f.epic)) return false;
    if (f.label && !t.labels.includes(f.label)) return false;
    if (f.status && S.view !== "board") {
      if (f.status === "open" ? t.status === "done" : t.status !== f.status) return false;
    }
    return true;
  }

  const filtersActive = () => {
    const f = S.filter;
    return !!(f.q || f.mine || f.assignees.size || f.kind || f.epic || f.label || f.status);
  };

  // ------------------------------------------------------------------ DOM
  const E = {};
  E.online = h("div", { class: "online" });
  E.connDot = h("span", { class: "conn-dot off", title: "Connecting…" });
  E.pname = h("span", { class: "pname" }, S.data.project.name);
  const topbar = h("header", { class: "topbar" },
    h("a", { href: "/", "data-link": "", class: "icon-btn", title: "Back to projects" }, icon("back")),
    E.pname,
    E.connDot,
    h("div", { class: "spacer" }),
    E.online,
    h("a", { href: `/project/${pid}`, "data-link": "", class: "btn ghost", title: "Open the LaTeX editor" }, icon("tex"), h("span", { class: "hide-narrow" }, "Editor")),
    userMenuButton(ctx));

  E.tabs = h("nav", { class: "view-tabs" }, VIEWS.map((v) => h("a", {
    href: `/project/${pid}/${v.id}`,
    class: "view-tab",
    dataset: { view: v.id },
    onclick: (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      setView(v.id);
    },
  }, icon(v.icon), h("span", null, v.label))));
  E.createBtn = h("button", { class: "btn primary", title: "Create issue (C)", onclick: () => createIssue() }, icon("plus"), h("span", null, "Create"));
  const toolbar = h("div", { class: "tasks-nav" },
    E.tabs,
    h("div", { class: "spacer" }),
    E.createBtn,
    h("button", { class: "icon-btn", title: "Board settings", onclick: () => settingsDialog() }, icon("settings")));
  E.filters = h("div", { class: "filter-bar" });
  E.body = h("main", { class: "tasks-body" });
  const page = h("div", { class: "tasks-page" }, topbar, toolbar, E.filters, E.body);
  root.append(page);

  // ------------------------------------------------------------------ rendering
  const views = {};
  const BUILDERS = {
    summary: summaryView,
    board: boardView,
    backlog: backlogView,
    list: listView,
    calendar: calendarView,
    timeline: timelineView,
  };

  function render() {
    if (S.destroyed) return;
    document.title = `${S.data.project.name} · ${VIEWS.find((v) => v.id === S.view).label} - Underleaf`;
    E.pname.textContent = S.data.project.name;
    for (const tab of E.tabs.children) tab.classList.toggle("active", tab.dataset.view === S.view);
    E.createBtn.classList.toggle("hidden", !S.canEdit);
    renderFilters();
    if (!views[S.view]) views[S.view] = BUILDERS[S.view]();
    const v = views[S.view];
    if (E.body.firstChild !== v.el) E.body.replaceChildren(v.el);
    E.body.dataset.view = S.view;
    v.render();
  }

  function setView(v) {
    if (v === S.view) return;
    S.view = v;
    S.quick = null;
    history.pushState(null, "", `/project/${pid}/${v}`);
    render();
  }

  // ------------------------------------------------------------------ filter bar
  function renderFilters() {
    const hide = S.view === "summary";
    E.filters.classList.toggle("hidden", hide);
    if (hide) return;
    const f = S.filter;
    const labels = [...new Set(S.data.tasks.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b));
    // Rebuild only when something the bar shows changed, so open dropdowns survive live updates.
    const sig = JSON.stringify([
      S.view === "board", S.data.members.map((m) => [m.id, m.display_name]), epics().map((e) => [e.id, e.title]), labels,
      f.mine, [...f.assignees], f.kind, f.epic, f.label, f.status, !!f.q,
    ]);
    if (sig === S.filterSig) return;
    S.filterSig = sig;

    // The search box lives outside the rebuilt part so it keeps focus while typing.
    if (!E.search) {
      E.search = h("input", { type: "search", placeholder: "Search issues…", "aria-label": "Search issues" });
      E.search.addEventListener("input", () => {
        f.q = E.search.value.trim();
        renderFilters();
        views[S.view].render();
      });
      E.filterRest = h("div", { class: "filter-rest" });
      E.filters.replaceChildren(E.search, E.filterRest);
    }
    const refilter = () => {
      renderFilters();
      views[S.view].render();
    };
    const people = [...S.data.members].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.display_name.localeCompare(b.display_name)));
    const avatarBtn = (id, name, content) => h("button", {
      class: "av-filter" + (f.assignees.has(id) ? " on" : ""),
      title: name,
      onclick: () => {
        if (f.assignees.has(id)) f.assignees.delete(id);
        else f.assignees.add(id);
        refilter();
      },
    }, content);
    const sel = (label, value, opts, onPick) => {
      const s = h("select", { class: "filter-select" + (value ? " on" : ""), "aria-label": label, onchange: () => { onPick(s.value); refilter(); } },
        h("option", { value: "" }, label), opts);
      setSelect(s, value);
      return s;
    };

    E.filterRest.replaceChildren(...[
      h("div", { class: "av-filters" },
        people.slice(0, 10).map((m) => avatarBtn(m.id, m.display_name, avatar({ id: m.id, display_name: m.display_name }))),
        avatarBtn(0, "Unassigned", h("span", { class: "avatar empty" }, icon("user")))),
      h("button", { class: "btn sm" + (f.mine ? " on" : ""), onclick: () => { f.mine = !f.mine; refilter(); } }, "Only my issues"),
      sel("Type", f.kind, KINDS.map((k) => h("option", { value: k.id }, k.label)), (v) => (f.kind = v)),
      sel("Epic", f.epic, [h("option", { value: "none" }, "No epic"), epics().map((e) => h("option", { value: String(e.id) }, `${keyOf(e)} ${e.title}`))], (v) => (f.epic = v)),
      labels.length ? sel("Label", f.label, labels.map((l) => h("option", { value: l }, l)), (v) => (f.label = v)) : null,
      S.view !== "board"
        ? sel("Status", f.status, [h("option", { value: "open" }, "Not done"), STATUSES.map((s) => h("option", { value: s.id }, s.label))], (v) => (f.status = v))
        : null,
      filtersActive()
        ? h("button", {
          class: "btn ghost sm",
          onclick: () => {
            Object.assign(f, { q: "", mine: false, kind: "", epic: "", label: "", status: "" });
            f.assignees.clear();
            E.search.value = "";
            refilter();
          },
        }, "Clear filters")
        : null,
    ].filter(Boolean));
  }

  // ------------------------------------------------------------------ issue dialogs
  function setTaskParam(num) {
    if (S.destroyed) return;
    const url = new URL(location.href);
    if (num == null) url.searchParams.delete("task");
    else url.searchParams.set("task", num);
    history.replaceState(null, "", url.pathname + url.search);
  }

  function openIssue(t) {
    if (S.dialog) S.dialog.close();
    const dlg = openTask({
      pid,
      id: t.id,
      me,
      onShow: (task) => setTaskParam(task.num),
      onChange: (task, deletedId) => applyLocal(task, deletedId),
      onClose: () => {
        if (S.dialog === dlg) {
          S.dialog = null;
          setTaskParam(null);
        }
      },
    });
    S.dialog = dlg;
  }

  /** Open or close the issue dialog to match ?task= in the URL. */
  function syncDialog() {
    const num = new URLSearchParams(location.search).get("task");
    if (!num) {
      if (S.dialog) S.dialog.close();
      return;
    }
    const t = S.data.tasks.find((x) => String(x.num) === num);
    if (!t) return toast(`${S.key}-${num} does not exist`, "warn");
    if (!S.dialog || S.dialog.id !== t.id) openIssue(t);
  }

  function createIssue(defaults = {}) {
    if (!S.canEdit) return;
    openCreate({ pid, data: context(), defaults, me, onCreated: (t) => applyLocal(t) });
  }

  /** Merge a task returned by the server into the local store and redraw. */
  function applyLocal(task, deletedId) {
    if (S.destroyed) return;
    if (deletedId != null) {
      S.data.tasks = S.data.tasks.filter((x) => x.id !== deletedId);
      for (const x of S.data.tasks) if (x.parent_id === deletedId) x.parent_id = null;
    } else if (task) {
      const i = S.data.tasks.findIndex((x) => x.id === task.id);
      const { description, ...rest } = task; // the store keeps list fields only
      if (i >= 0) S.data.tasks[i] = { ...S.data.tasks[i], ...rest };
      else S.data.tasks.push(rest);
      sortTasks();
    }
    S.byId = new Map(S.data.tasks.map((t) => [t.id, t]));
    render();
  }

  /** Optimistically patch an issue, then take the server's answer. */
  async function updateTask(t, body) {
    const before = { ...t };
    Object.assign(t, body);
    render();
    try {
      applyLocal(await patch(`/api/projects/${pid}/tasks/${t.id}`, body));
    } catch (e) {
      Object.assign(t, before);
      render();
      toast(e.message, "error");
    }
  }

  /** Drag and drop: apply `changes` (status / sprint) and place `t` between two issues. */
  async function moveTask(t, changes, prev, next) {
    const diff = Object.fromEntries(Object.entries(changes).filter(([k, v]) => (t[k] ?? null) !== v));
    if (!Object.keys(diff).length && prev == null && next == null) return;
    const before = { ...t };
    const p = prev != null ? S.byId.get(prev) : null;
    const n = next != null ? S.byId.get(next) : null;
    Object.assign(t, diff);
    if (p && n) t.sort_key = (p.sort_key + n.sort_key) / 2;
    else if (p) t.sort_key = p.sort_key + 1024;
    else if (n) t.sort_key = n.sort_key - 1024;
    if (diff.status === "done") t.resolved_at = Date.now() / 1000;
    sortTasks();
    render();
    try {
      applyLocal(await patch(`/api/projects/${pid}/tasks/${t.id}`, { ...diff, position: { prev, next } }));
    } catch (e) {
      Object.assign(t, before);
      sortTasks();
      render();
      toast(e.message, "error");
    }
  }

  // ------------------------------------------------------------------ drag and drop between lists
  const dropLine = h("div", { class: "drop-line" });

  function draggable(el, t) {
    el.addEventListener("dragstart", (e) => {
      S.dragging = t;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", keyOf(t));
      requestAnimationFrame(() => el.classList.add("dragging"));
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      endDrag();
    });
  }

  function endDrag() {
    S.dragging = null;
    dropLine.remove();
    document.querySelectorAll(".drop-over").forEach((x) => x.classList.remove("drop-over"));
    if (S.pendingReload) {
      S.pendingReload = false;
      scheduleReload();
    }
  }

  /** Make `list` accept dropped issues; onDrop(task, prevId, nextId). */
  function dropList(list, itemSel, accepts, onDrop) {
    list.addEventListener("dragover", (e) => {
      if (!S.dragging || !accepts(S.dragging)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      list.classList.add("drop-over");
      const items = [...list.querySelectorAll(itemSel)].filter((x) => !x.classList.contains("dragging"));
      const below = items.find((x) => {
        const r = x.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (below) list.insertBefore(dropLine, below);
      else list.append(dropLine);
    });
    list.addEventListener("dragleave", (e) => {
      if (list.contains(e.relatedTarget)) return;
      list.classList.remove("drop-over");
      if (dropLine.parentNode === list) dropLine.remove();
    });
    list.addEventListener("drop", (e) => {
      const t = S.dragging;
      if (!t || !accepts(t)) return;
      e.preventDefault();
      const near = (el, dir) => {
        let x = el && el[dir];
        while (x && (x.classList.contains("dragging") || !x.matches(itemSel))) x = x[dir];
        return x ? Number(x.dataset.id) : null;
      };
      const inList = dropLine.parentNode === list;
      const prev = inList ? near(dropLine, "previousElementSibling") : null;
      const next = inList ? near(dropLine, "nextElementSibling") : null;
      endDrag();
      onDrop(t, prev, next);
    });
  }

  // ------------------------------------------------------------------ inline create
  function quickSlot(where, fields) {
    if (!S.canEdit) return null;
    if (!S.quick || S.quick.where !== where) {
      return h("button", { class: "quick-add", onclick: () => { S.quick = { where, text: "", kind: "task" }; render(); } }, icon("plus"), "Create issue");
    }
    const q = S.quick;
    const kind = h("select", { class: "quick-kind", "aria-label": "Issue type", onchange: () => (q.kind = kind.value) },
      KINDS.filter((k) => k.id !== "epic").map((k) => h("option", { value: k.id }, k.label)));
    setSelect(kind, q.kind);
    const input = h("input", { type: "text", maxlength: 255, placeholder: "What needs to be done? (Enter to create)" });
    input.value = q.text;
    input.addEventListener("input", () => (q.text = input.value));
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        S.quick = null;
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        input.disabled = true;
        try {
          const t = await post(`/api/projects/${pid}/tasks`, { title, kind: kind.value, ...fields });
          q.text = "";
          applyLocal(t);
        } catch (ex) {
          toast(ex.message, "error");
          input.disabled = false;
          input.focus();
        }
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        const ae = document.activeElement;
        if (S.quick === q && !q.text.trim() && !(ae && ae.closest && ae.closest(".quick-form"))) {
          S.quick = null;
          render();
        }
      }, 150);
    });
    requestAnimationFrame(() => input.isConnected && !input.disabled && input.focus());
    return h("div", { class: "quick-form" }, kind, input);
  }

  // ------------------------------------------------------------------ sprints
  function sprintDialog(s, mode) {
    const name = h("input", { type: "text", maxlength: 80 });
    name.value = s.name;
    const duration = h("select", null,
      [1, 2, 3, 4].map((w) => h("option", { value: w }, plural(w, "week"))),
      h("option", { value: "custom" }, "Custom"));
    const start = h("input", { type: "date" });
    const end = h("input", { type: "date" });
    start.value = s.start_date || today();
    if (s.end_date) {
      end.value = s.end_date;
      const days = dayDiff(start.value, end.value) + 1;
      setSelect(duration, days % 7 === 0 && days / 7 <= 4 ? days / 7 : "custom");
    } else {
      setSelect(duration, 2);
      end.value = addDays(start.value, 13);
    }
    const goal = h("textarea", { rows: 3, placeholder: "What should this sprint achieve? (optional)" });
    goal.value = s.goal || "";
    const err = h("div", { class: "form-error" });
    const fitEnd = () => {
      if (duration.value !== "custom" && start.value) end.value = addDays(start.value, Number(duration.value) * 7 - 1);
    };
    duration.addEventListener("change", fitEnd);
    start.addEventListener("change", fitEnd);
    end.addEventListener("change", () => setSelect(duration, "custom"));
    const save = async () => {
      err.textContent = "";
      const body = { name: name.value.trim() || s.name, goal: goal.value, start_date: start.value || null, end_date: end.value || null };
      if (mode === "start") body.state = "active";
      try {
        await patch(`/api/projects/${pid}/sprints/${s.id}`, body);
        m.close();
        if (mode === "start") toast(`${body.name} started`, "success");
        await reload();
        if (mode === "start" && S.view !== "board") setView("board");
      } catch (e) {
        err.textContent = e.message;
      }
    };
    const count = S.data.tasks.filter((t) => t.sprint_id === s.id && t.kind !== "epic").length;
    const m = modal({
      title: mode === "start" ? "Start sprint" : "Edit sprint",
      body: h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); save(); } },
        mode === "start" ? h("p", { class: "muted small", style: { margin: "0 0 4px" } }, `${plural(count, "issue")} will be included in this sprint.`) : null,
        h("label", null, "Sprint name"), name,
        h("div", { class: "grid3" },
          h("div", null, h("label", null, "Duration"), duration),
          h("div", null, h("label", null, "Start date"), start),
          h("div", null, h("label", null, "End date"), end)),
        h("label", null, "Sprint goal"), goal,
        err),
      actions: [
        h("button", { class: "btn", onclick: () => m.close() }, "Cancel"),
        h("button", { class: "btn primary", onclick: save }, mode === "start" ? "Start" : "Save"),
      ],
    });
  }

  function completeSprint(s) {
    const issues = S.data.tasks.filter((t) => t.sprint_id === s.id && t.kind !== "epic");
    const done = issues.filter((t) => t.status === "done").length;
    const open = issues.length - done;
    const planned = S.data.sprints.filter((x) => x.state === "planned");
    const target = h("select", null,
      h("option", { value: "" }, "Backlog"),
      planned.map((x) => h("option", { value: x.id }, x.name)),
      h("option", { value: "new" }, "New sprint"));
    const err = h("div", { class: "form-error" });
    const finish = async () => {
      err.textContent = "";
      try {
        let moveTo = target.value ? Number(target.value) : null;
        if (open && target.value === "new") moveTo = (await post(`/api/projects/${pid}/sprints`, {})).id;
        const body = { state: "closed" };
        if (open && moveTo) body.move_to = moveTo;
        await patch(`/api/projects/${pid}/sprints/${s.id}`, body);
        m.close();
        toast(`${s.name} completed: ${plural(done, "issue")} done`, "success");
        reload();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    const m = modal({
      title: `Complete ${s.name}`,
      body: h("div", { class: "form" },
        h("div", { class: "sprint-result" },
          h("div", null, h("strong", null, String(done)), h("span", { class: "muted" }, plural(done, "completed issue").replace(/^\d+ /, ""))),
          h("div", null, h("strong", null, String(open)), h("span", { class: "muted" }, plural(open, "open issue").replace(/^\d+ /, "")))),
        open
          ? [h("label", null, "Move open issues to"), target]
          : h("p", { class: "muted" }, "All issues in this sprint are done."),
        err),
      actions: [
        h("button", { class: "btn", onclick: () => m.close() }, "Cancel"),
        h("button", { class: "btn primary", onclick: finish }, "Complete sprint"),
      ],
    });
  }

  async function createSprint() {
    try {
      const s = await post(`/api/projects/${pid}/sprints`, {});
      S.data.sprints.push(s);
      render();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function deleteSprint(s) {
    const n = S.data.tasks.filter((t) => t.sprint_id === s.id).length;
    if (!(await confirmDialog("Delete sprint", `Delete ${s.name}?${n ? ` Its ${plural(n, "issue")} move back to the backlog.` : ""}`, { okText: "Delete", danger: true }))) return;
    try {
      await del(`/api/projects/${pid}/sprints/${s.id}`);
      reload();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function sprintMeta(s) {
    return h("div", { class: "sprint-meta" },
      s.start_date ? h("span", { class: "muted small" }, icon("calendar"), sprintDates(s)) : null,
      s.state === "active" && s.end_date ? h("span", { class: "muted small" }, icon("clock"), sprintRemaining(s)) : null,
      s.goal ? h("span", { class: "sprint-goal", title: "Sprint goal" }, s.goal) : null);
  }

  // ------------------------------------------------------------------ board
  function card(t) {
    const epic = t.parent_id ? S.byId.get(t.parent_id) : null;
    const el = h("article", {
      class: "card" + (t.status === "done" ? " done" : ""),
      draggable: canMove(t) ? "true" : "false",
      dataset: { id: t.id },
      tabindex: 0,
      onclick: () => openIssue(t),
      onkeydown: (e) => e.key === "Enter" && openIssue(t),
    },
      h("div", { class: "card-title" }, t.title),
      epic || t.labels.length ? h("div", { class: "card-tags" }, epicChip(epic), labelChips(t.labels)) : null,
      h("div", { class: "card-foot" },
        kindIcon(t.kind),
        h("span", { class: "card-key" }, keyOf(t)),
        dueBadge(t),
        h("span", { class: "spacer" }),
        t.comments ? h("span", { class: "meta", title: plural(t.comments, "comment") }, icon("chat"), String(t.comments)) : null,
        points(t),
        priorityIcon(t.priority),
        assigneeAvatar(t)));
    if (canMove(t)) draggable(el, t);
    return el;
  }

  function boardView() {
    const el = h("div", { class: "board-view" });
    function render() {
      const sprint = activeSprint();
      const scope = sprint && S.scope === "sprint" ? "sprint" : "all";
      const cutoff = Date.now() / 1000 - DONE_VISIBLE_SECS;
      let hiddenDone = 0;
      const tasks = S.data.tasks.filter((t) => {
        if (t.kind === "epic") return false;
        if (scope === "sprint") {
          if (t.sprint_id !== sprint.id) return false;
        } else if (t.status === "done" && t.resolved_at && t.resolved_at < cutoff) {
          hiddenDone++;
          return false;
        }
        return passes(t);
      });

      const scopeSel = sprint
        ? (() => {
          const s = h("select", { class: "filter-select", "aria-label": "Board scope", onchange: () => { S.scope = s.value; saveLS(`ul:board-scope:${pid}`, s.value); render(); } },
            h("option", { value: "sprint" }, "Active sprint"),
            h("option", { value: "all" }, "All issues"));
          setSelect(s, scope);
          return s;
        })()
        : null;
      const head = h("div", { class: "view-head" },
        h("div", { class: "grow" },
          h("h2", null, scope === "sprint" ? sprint.name : "All issues"),
          scope === "sprint"
            ? sprintMeta(sprint)
            : h("div", { class: "muted small" }, sprint
              ? "Every issue in the project."
              : "No active sprint, so the board shows every issue. Plan and start sprints in the Backlog.")),
        scopeSel,
        scope === "sprint" && S.canEdit ? h("button", { class: "btn", onclick: () => completeSprint(sprint) }, "Complete sprint") : null);

      const cols = STATUSES.map((s) => {
        const list = tasks.filter((t) => t.status === s.id);
        const body = h("div", { class: "col-body" }, list.map(card));
        dropList(body, ".card", canMove, (t, prev, next) => moveTask(t, { status: s.id }, prev, next));
        const pts = list.reduce((a, t) => a + (t.estimate || 0), 0);
        return h("section", { class: `col s-${s.id}` },
          h("header", { class: "col-head" },
            h("span", { class: "dot" }),
            h("span", { class: "col-name" }, s.label),
            h("span", { class: "count", title: plural(list.length, "issue") }, String(list.length)),
            pts ? h("span", { class: "muted small", title: "Story points" }, `${pts} pts`) : null),
          body,
          quickSlot(`col:${s.id}`, { status: s.id, sprint_id: scope === "sprint" ? sprint.id : null }));
      });
      el.replaceChildren(head, h("div", { class: "columns" }, cols));
      if (hiddenDone) {
        el.append(h("p", { class: "muted small board-note" }, `${plural(hiddenDone, "issue")} finished more than two weeks ago ${hiddenDone === 1 ? "is" : "are"} hidden. The List view shows everything.`));
      }
    }
    return { el, render };
  }

  // ------------------------------------------------------------------ backlog
  function blRow(t) {
    const epic = t.parent_id ? S.byId.get(t.parent_id) : null;
    const el = h("div", {
      class: "bl-row" + (t.status === "done" ? " done" : ""),
      dataset: { id: t.id },
      draggable: S.canEdit ? "true" : "false",
      tabindex: 0,
      onclick: () => openIssue(t),
      onkeydown: (e) => e.key === "Enter" && openIssue(t),
    },
      kindIcon(t.kind),
      h("span", { class: "card-key" }, keyOf(t)),
      h("span", { class: "bl-title" }, t.title),
      h("span", { class: "bl-tags" }, epicChip(epic), labelChips(t.labels.slice(0, 2))),
      dueBadge(t),
      statusPicker(t.status, canMove(t), (s) => moveTask(t, { status: s }, null, null)),
      h("span", { class: "points-slot" }, points(t)),
      priorityIcon(t.priority),
      assigneeAvatar(t));
    if (S.canEdit) draggable(el, t);
    return el;
  }

  function backlogView() {
    const el = h("div", { class: "backlog-view" });

    function section(sprint) {
      const where = sprint ? `sprint:${sprint.id}` : "backlog";
      // The backlog also catches unfinished issues left in completed sprints.
      const inSection = (t) => t.kind !== "epic" && (sprint
        ? t.sprint_id === sprint.id
        : t.sprint_id == null || (sprintOf(t.sprint_id) || {}).state === "closed");
      const all = S.data.tasks.filter((t) => inSection(t) && (sprint || t.status !== "done"));
      const finished = sprint ? 0 : S.data.tasks.filter((t) => t.kind !== "epic" && t.sprint_id == null && t.status === "done").length;
      const items = all.filter(passes);
      const collapsed = S.collapsed.has(where);
      const pts = all.reduce((a, t) => a + (t.estimate || 0), 0);
      const toggle = () => {
        if (collapsed) S.collapsed.delete(where);
        else S.collapsed.add(where);
        saveLS(`ul:bl-collapsed:${pid}`, [...S.collapsed]);
        render();
      };

      let actions = null;
      if (S.canEdit && sprint) {
        const more = h("button", {
          class: "icon-btn",
          title: "Sprint actions",
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            contextMenu(r.right - 170, r.bottom + 2, [
              { label: "Edit sprint", action: () => sprintDialog(sprint, "edit") },
              sprint.state === "planned" ? "-" : null,
              sprint.state === "planned" ? { label: "Delete sprint", danger: true, action: () => deleteSprint(sprint) } : null,
            ]);
          },
        }, icon("more"));
        const main = sprint.state === "active"
          ? h("button", { class: "btn sm", onclick: () => completeSprint(sprint) }, "Complete sprint")
          : h("button", {
            class: "btn sm",
            onclick: () => (activeSprint() ? toast("Complete the active sprint before starting another one", "warn") : sprintDialog(sprint, "start")),
          }, "Start sprint");
        actions = [main, more];
      } else if (S.canEdit) {
        actions = h("button", { class: "btn sm", onclick: createSprint }, icon("plus"), "Create sprint");
      }

      const counts = STATUSES.map((s) => [s, all.filter((t) => t.status === s.id).length]).filter(([, n]) => n);
      const head = h("header", { class: "bl-head" },
        h("button", { class: "icon-btn caret", title: collapsed ? "Expand" : "Collapse", onclick: toggle }, collapsed ? "▸" : "▾"),
        h("strong", { class: "bl-name", onclick: toggle }, sprint ? sprint.name : "Backlog"),
        sprint && sprint.state === "active" ? h("span", { class: "role-badge owner" }, "active") : null,
        sprint && sprint.start_date ? h("span", { class: "muted small" }, sprintDates(sprint)) : null,
        h("span", { class: "muted small" }, plural(all.length, "issue") + (pts ? ` · ${pts} pts` : "")),
        h("div", { class: "spacer" }),
        h("span", { class: "status-counts" }, counts.map(([s, n]) => h("span", { class: `n s-${s.id}`, title: `${s.label}: ${n}` }, String(n)))),
        actions);

      const list = h("div", { class: "bl-list" + (collapsed ? " hidden" : "") },
        items.map(blRow),
        !items.length
          ? h("div", { class: "bl-empty" }, all.length ? "No issues match the filters." : sprint ? "Plan this sprint by dragging issues here from the backlog." : "The backlog is empty. Create an issue below.")
          : null);
      if (S.canEdit) dropList(list, ".bl-row", () => true, (t, prev, next) => moveTask(t, { sprint_id: sprint ? sprint.id : null }, prev, next));

      return h("section", { class: "bl-section" + (sprint && sprint.state === "active" ? " active" : "") },
        head,
        sprint && sprint.goal && !collapsed ? h("div", { class: "sprint-goal bl-goal" }, sprint.goal) : null,
        list,
        collapsed ? null : quickSlot(where, { sprint_id: sprint ? sprint.id : null }),
        finished && !collapsed ? h("div", { class: "muted small bl-foot" }, `${plural(finished, "finished issue")} not in a sprint ${finished === 1 ? "is" : "are"} hidden. See the List view.`) : null);
    }

    function render() {
      const open = S.data.sprints.filter((s) => s.state !== "closed");
      el.replaceChildren(...open.map(section), section(null));
    }
    return { el, render };
  }

  // ------------------------------------------------------------------ list
  function listView() {
    const el = h("div", { class: "list-view" });
    const COLS = [
      { id: "kind", label: "Type", get: (t) => KIND_RANK[t.kind] },
      { id: "key", label: "Key", get: (t) => t.num },
      { id: "title", label: "Summary", get: (t) => t.title.toLowerCase() },
      { id: "status", label: "Status", get: (t) => STATUS_RANK[t.status] },
      { id: "assignee", label: "Assignee", get: (t) => (t.assignee_name || "￿").toLowerCase() },
      { id: "priority", label: "Priority", get: (t) => PRIORITY_RANK[t.priority] },
      { id: "sprint", label: "Sprint", get: (t) => (sprintOf(t.sprint_id) || { name: "￿" }).name.toLowerCase() },
      { id: "due", label: "Due", get: (t) => t.due_date || "9999" },
      { id: "updated", label: "Updated", get: (t) => t.updated_at },
    ];

    function rows() {
      const col = COLS.find((c) => c.id === S.sort.col) || COLS[1];
      return S.data.tasks.filter(passes).sort((a, b) => {
        const x = col.get(a);
        const y = col.get(b);
        return (x < y ? -1 : x > y ? 1 : 0) * S.sort.dir || b.num - a.num;
      });
    }

    function exportCsv(list) {
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const head = ["Key", "Summary", "Type", "Status", "Priority", "Assignee", "Reporter", "Sprint", "Epic", "Labels", "Start date", "Due date", "Story points", "Created", "Updated"];
      const lines = [head.map(q).join(",")];
      for (const t of list) {
        const epic = t.parent_id ? S.byId.get(t.parent_id) : null;
        lines.push([
          keyOf(t), t.title, kindLabel(t.kind), statusLabel(t.status), priorityLabel(t.priority), t.assignee_name, t.reporter_name,
          (sprintOf(t.sprint_id) || {}).name, epic ? keyOf(epic) : "", t.labels.join(" "), t.start_date, t.due_date, t.estimate,
          new Date(t.created_at * 1000).toISOString(), new Date(t.updated_at * 1000).toISOString(),
        ].map(q).join(","));
      }
      const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
      const a = h("a", { href: url, download: `${S.key}-issues-${today()}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function render() {
      const list = rows();
      const th = (c) => h("th", {
        class: "sortable" + (S.sort.col === c.id ? " sorted" : "") + ` col-${c.id}`,
        onclick: () => {
          S.sort = S.sort.col === c.id ? { col: c.id, dir: -S.sort.dir } : { col: c.id, dir: c.id === "updated" || c.id === "key" ? -1 : 1 };
          render();
        },
      }, c.label, S.sort.col === c.id ? h("span", { class: "sort-arrow" }, S.sort.dir > 0 ? "▲" : "▼") : null);
      const tr = (t) => {
        const epic = t.parent_id ? S.byId.get(t.parent_id) : null;
        return h("tr", { class: t.status === "done" ? "done" : "", onclick: () => openIssue(t) },
          h("td", { class: "col-kind" }, kindIcon(t.kind)),
          h("td", { class: "col-key" }, h("span", { class: "card-key" }, keyOf(t))),
          h("td", { class: "col-title" }, h("span", { class: "title" }, t.title), epicChip(epic), labelChips(t.labels)),
          h("td", { class: "col-status" }, statusPicker(t.status, canMove(t), (s) => updateTask(t, { status: s }))),
          h("td", { class: "col-assignee" }, h("span", { class: "row tight" }, assigneeAvatar(t), h("span", { class: "ellipsis" }, t.assignee_name || "Unassigned"))),
          h("td", { class: "col-priority" }, h("span", { class: "row tight" }, priorityIcon(t.priority), priorityLabel(t.priority))),
          h("td", { class: "col-sprint muted" }, (sprintOf(t.sprint_id) || {}).name || ""),
          h("td", { class: "col-due" }, dueBadge(t)),
          h("td", { class: "col-updated muted" }, timeAgo(t.updated_at)));
      };
      el.replaceChildren(
        h("div", { class: "view-head" },
          h("h2", null, "All issues"),
          h("span", { class: "muted small" }, plural(list.length, "issue") + (filtersActive() ? ` of ${S.data.tasks.length}` : "")),
          h("div", { class: "spacer" }),
          list.length ? h("button", { class: "btn sm", onclick: () => exportCsv(list) }, icon("download"), "Export CSV") : null),
        list.length
          ? h("div", { class: "table-wrap" }, h("table", { class: "project-table issue-table" },
            h("thead", null, h("tr", null, COLS.map(th))),
            h("tbody", null, list.map(tr))))
          : emptyState());
    }
    return { el, render };
  }

  function emptyState() {
    if (filtersActive()) return h("div", { class: "empty-state" }, h("h3", null, "No matching issues"), h("p", null, "Try removing some filters."));
    return h("div", { class: "empty-state" },
      h("h3", null, "No issues yet"),
      h("p", null, S.canEdit ? "Create the first issue for this project, then assign it to a collaborator." : "Nobody has created an issue in this project yet."),
      S.canEdit ? h("button", { class: "btn primary", onclick: () => createIssue() }, icon("plus"), "Create issue") : null);
  }

  // ------------------------------------------------------------------ calendar
  function calendarView() {
    return taskCalendar({
      tasks: () => S.data.tasks.filter(passes),
      keyOf,
      onOpen: openIssue,
      canMove: () => S.canEdit,
      onMove: (t, date) => {
        const body = { due_date: date };
        if (date && t.start_date && t.start_date > date) body.start_date = date; // keep start <= due
        updateTask(t, body);
      },
      canCreate: () => S.canEdit,
      onCreate: (date) => createIssue({ due_date: date }),
    });
  }

  // ------------------------------------------------------------------ timeline
  function timelineView() {
    let zoom = loadLS("ul:tl-zoom", "weeks");
    let scrollToToday = true;
    const closed = new Set(loadLS(`ul:tl-closed:${pid}`, []));
    const scroller = h("div", { class: "tl-scroll" });
    const zoomBtns = h("div", { class: "seg" });
    const el = h("div", { class: "timeline-view" },
      h("div", { class: "view-head" },
        h("div", { class: "grow" },
          h("h2", null, "Timeline"),
          h("div", { class: "muted small" }, "Epics with their issues over time. Drag a bar to move it, or its ends to change the start and due dates.")),
        h("button", { class: "btn sm", onclick: () => { scrollToToday = true; render(); } }, "Today"),
        zoomBtns),
      scroller);

    const LABEL_W = 300;
    const spanOf = (t) => {
      const s = t.start_date || t.due_date;
      return s ? { s, e: t.due_date || t.start_date, derived: false } : null;
    };

    function epicSpan(e) {
      const own = spanOf(e);
      if (own) return own;
      let s = null;
      let en = null;
      for (const k of S.data.tasks) {
        if (k.parent_id !== e.id) continue;
        const sp = spanOf(k);
        if (!sp) continue;
        if (!s || sp.s < s) s = sp.s;
        if (!en || sp.e > en) en = sp.e;
      }
      return s ? { s, e: en, derived: true } : null;
    }

    function render() {
      const dayW = zoom === "weeks" ? 32 : 9;
      zoomBtns.replaceChildren(...["weeks", "months"].map((z) => h("button", {
        class: "btn sm" + (zoom === z ? " on" : ""),
        onclick: () => { zoom = z; saveLS("ul:tl-zoom", z); scrollToToday = true; render(); },
      }, z === "weeks" ? "Weeks" : "Months")));

      // Rows: each epic followed by its issues, then dated issues without an epic.
      const shown = S.data.tasks.filter(passes);
      const rows = [];
      for (const e of epics()) {
        const kids = shown.filter((t) => t.parent_id === e.id);
        if (!passes(e) && !kids.length) continue;
        rows.push({ t: e, epic: true, kids });
        if (!closed.has(e.id)) for (const k of kids) rows.push({ t: k, depth: 1 });
      }
      const loose = shown.filter((t) => t.kind !== "epic" && t.parent_id == null && spanOf(t));
      if (loose.length) {
        rows.push({ group: "Issues without an epic" });
        for (const t of loose) rows.push({ t, depth: 0 });
      }

      const spans = new Map(rows.filter((r) => r.t).map((r) => [r.t.id, r.epic ? epicSpan(r.t) : spanOf(r.t)]));
      const t0 = today();
      let min = addDays(t0, -21);
      let max = addDays(t0, zoom === "weeks" ? 70 : 200);
      for (const sp of spans.values()) {
        if (!sp) continue;
        if (sp.s < min) min = sp.s;
        if (sp.e > max) max = sp.e;
      }
      min = addDays(min, -7);
      min = addDays(min, -((parseDate(min).getDay() + 6) % 7)); // start on a Monday
      const days = Math.min(dayDiff(min, addDays(max, 14)) + 1, 366 * 3);
      const width = days * dayW;
      const x = (d) => dayDiff(min, d) * dayW;

      // Scale: months, then days (weeks zoom) or week starts (months zoom).
      const months = [];
      const dayCells = [];
      const bg = [];
      for (let i = 0; i < days; i++) {
        const ds = addDays(min, i);
        const d = parseDate(ds);
        if (i === 0 || d.getDate() === 1) {
          months.push({ i, label: d.toLocaleDateString(undefined, { month: zoom === "weeks" ? "long" : "short", year: "numeric" }) });
        }
        const weekend = d.getDay() === 0 || d.getDay() === 6;
        if (zoom === "weeks") {
          dayCells.push(h("div", { class: "tl-dcell" + (weekend ? " weekend" : "") + (ds === t0 ? " today" : ""), style: { left: i * dayW + "px", width: dayW + "px" } }, String(d.getDate())));
          if (weekend) bg.push(h("div", { class: "tl-weekend", style: { left: i * dayW + "px", width: dayW + "px" } }));
        } else if (d.getDay() === 1) {
          dayCells.push(h("div", { class: "tl-dcell week", style: { left: i * dayW + "px" } }, String(d.getDate())));
          bg.push(h("div", { class: "tl-gridline", style: { left: i * dayW + "px" } }));
        }
      }
      const monthEls = months.map((mo, j) => {
        const end = j + 1 < months.length ? months[j + 1].i : days;
        return h("div", { class: "tl-month", style: { left: mo.i * dayW + "px", width: (end - mo.i) * dayW + "px" } }, h("span", null, mo.label));
      });

      const header = h("div", { class: "tl-header" },
        h("div", { class: "tl-corner", style: { width: LABEL_W + "px" } }, "Issue"),
        h("div", { class: "tl-scale", style: { width: width + "px" } }, h("div", { class: "tl-months" }, monthEls), h("div", { class: "tl-days" }, dayCells)));

      const todayLine = h("div", { class: "tl-today", style: { left: x(t0) + dayW / 2 + "px" }, title: "Today" });
      const body = h("div", { class: "tl-body" },
        h("div", { class: "tl-bg", style: { left: LABEL_W + "px", width: width + "px" } }, bg, todayLine),
        rows.map((r) => rowEl(r)));

      function rowEl(r) {
        if (r.group) return h("div", { class: "tl-row group" }, h("div", { class: "tl-label", style: { width: LABEL_W + "px" } }, r.group), h("div", { class: "tl-track", style: { width: width + "px" } }));
        const t = r.t;
        const label = h("div", { class: "tl-label", style: { width: LABEL_W + "px", paddingLeft: 8 + (r.depth || 0) * 20 + "px" } },
          r.epic
            ? h("button", {
              class: "icon-btn caret",
              title: closed.has(t.id) ? "Show issues" : "Hide issues",
              onclick: () => {
                if (closed.has(t.id)) closed.delete(t.id);
                else closed.add(t.id);
                saveLS(`ul:tl-closed:${pid}`, [...closed]);
                render();
              },
            }, r.kids.length ? (closed.has(t.id) ? "▸" : "▾") : "")
            : null,
          kindIcon(t.kind),
          h("span", { class: "card-key" }, keyOf(t)),
          h("button", { class: "tl-title", title: t.title, onclick: () => openIssue(t) }, t.title));
        const track = h("div", { class: "tl-track", style: { width: width + "px" } });
        const sp = spans.get(t.id);
        if (sp) track.append(bar(t, sp, r));
        else if (S.canEdit) {
          track.classList.add("schedulable");
          track.title = "Click to schedule";
          track.addEventListener("click", (e) => {
            const day = addDays(min, Math.floor((e.clientX - track.getBoundingClientRect().left) / dayW));
            updateTask(t, { start_date: day, due_date: day });
          });
        }
        return h("div", { class: "tl-row" + (r.epic ? " epic" : "") }, label, track);
      }

      function bar(t, sp, r) {
        const w = (dayDiff(sp.s, sp.e) + 1) * dayW;
        const b = h("div", {
          class: `tl-bar s-${t.status}` + (r.epic ? " epic" : "") + (sp.derived ? " derived" : "") + (w < 90 ? " narrow" : ""),
          style: { left: x(sp.s) + "px", width: w + "px" },
          title: `${keyOf(t)} ${t.title}\n${fmtDate(sp.s, true)} – ${fmtDate(sp.e, true)}${sp.derived ? "\n(from its child issues)" : ""}`,
        });
        if (r.epic) {
          const kids = S.data.tasks.filter((k) => k.parent_id === t.id);
          const done = kids.filter((k) => k.status === "done").length;
          if (kids.length) b.append(h("span", { class: "tl-progress", style: { width: (done / kids.length) * 100 + "%" } }));
        }
        b.append(h("span", { class: "tl-bar-label" }, t.title));
        if (S.canEdit && !sp.derived) {
          b.append(h("span", { class: "tl-handle l" }), h("span", { class: "tl-handle r" }));
          dragBar(b, t, sp, dayW);
        } else {
          b.addEventListener("click", () => openIssue(t));
        }
        return b;
      }

      const keep = { left: scroller.scrollLeft, top: scroller.scrollTop };
      scroller.replaceChildren(h("div", { class: "tl-inner", style: { width: LABEL_W + width + "px" } }, header, body,
        rows.length ? null : h("div", { class: "tl-empty muted" }, filtersActive() ? "No issues match the filters." : "Create an epic, or give issues start and due dates, to see them here.")));
      if (scrollToToday) {
        scrollToToday = false;
        requestAnimationFrame(() => (scroller.scrollLeft = Math.max(0, x(t0) - (scroller.clientWidth - LABEL_W) / 3)));
      } else {
        scroller.scrollLeft = keep.left;
        scroller.scrollTop = keep.top;
      }
    }

    function dragBar(b, t, sp, dayW) {
      b.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const mode = e.target.classList.contains("l") ? "start" : e.target.classList.contains("r") ? "end" : "move";
        const x0 = e.clientX;
        const left0 = parseFloat(b.style.left);
        const width0 = parseFloat(b.style.width);
        const len = dayDiff(sp.s, sp.e);
        let d = 0;
        b.setPointerCapture(e.pointerId);
        b.classList.add("dragging");
        const clamp = (v) => (mode === "start" ? Math.min(v, len) : mode === "end" ? Math.max(v, -len) : v);
        const move = (ev) => {
          d = clamp(Math.round((ev.clientX - x0) / dayW));
          if (mode === "move") b.style.left = left0 + d * dayW + "px";
          else if (mode === "start") {
            b.style.left = left0 + d * dayW + "px";
            b.style.width = width0 - d * dayW + "px";
          } else b.style.width = width0 + d * dayW + "px";
        };
        const up = (ev) => {
          b.removeEventListener("pointermove", move);
          b.removeEventListener("pointerup", up);
          b.removeEventListener("pointercancel", up);
          b.classList.remove("dragging");
          if (d === 0) {
            if (ev.type === "pointerup") openIssue(t);
            return;
          }
          const body = {};
          if (mode === "move") {
            if (t.start_date) body.start_date = addDays(t.start_date, d);
            if (t.due_date) body.due_date = addDays(t.due_date, d);
          } else {
            body.start_date = mode === "start" ? addDays(sp.s, d) : sp.s;
            body.due_date = mode === "end" ? addDays(sp.e, d) : sp.e;
          }
          updateTask(t, body);
        };
        b.addEventListener("pointermove", move);
        b.addEventListener("pointerup", up);
        b.addEventListener("pointercancel", up);
      });
    }

    return { el, render };
  }

  // ------------------------------------------------------------------ summary
  function summaryView() {
    const el = h("div", { class: "summary-view" });
    let feed = null;
    let feedVersion = -1;

    async function loadFeed() {
      feedVersion = S.version;
      try {
        feed = await get(`/api/projects/${pid}/activity`);
        if (S.view === "summary") render();
      } catch {
        /* the feed is optional */
      }
    }

    const tile = (label, value, note, tone) => h("div", { class: "stat-tile" + (tone ? ` ${tone}` : "") },
      h("div", { class: "stat-label" }, label),
      h("div", { class: "stat-value" }, String(value)),
      note ? h("div", { class: "stat-note muted small" }, note) : null);

    const card = (title, sub, ...body) => h("section", { class: "sum-card" },
      h("header", null, h("h3", null, title), sub ? h("span", { class: "muted small" }, sub) : null),
      body);

    /** One thin horizontal bar per category, a single hue; labels and counts carry the values. */
    const bars = (rows, total) => h("div", { class: "hbars" }, rows.map((r) => {
      const pct = total ? (r.n / total) * 100 : 0;
      return h("div", { class: "hbar-row", title: `${r.name}: ${r.n} (${Math.round(pct)}%)` },
        h("span", { class: "hbar-label" }, r.icon, h("span", { class: "ellipsis" }, r.name)),
        h("span", { class: "hbar-track" }, h("span", { class: "hbar-fill", style: { width: (r.n ? Math.max(pct, 1.5) : 0) + "%" } })),
        h("span", { class: "hbar-value" }, String(r.n)));
    }));

    function render() {
      if (feedVersion !== S.version) loadFeed();
      const issues = S.data.tasks.filter((t) => t.kind !== "epic");
      const now = Date.now() / 1000;
      const week = 7 * 86400;
      const t0 = today();
      const in7 = addDays(t0, 7);
      const open = issues.filter((t) => t.status !== "done");
      const overdue = open.filter(isOverdue);
      const dueSoon = open.filter((t) => t.due_date && t.due_date >= t0 && t.due_date <= in7);
      const doneWeek = issues.filter((t) => t.status === "done" && t.resolved_at >= now - week);
      const createdWeek = issues.filter((t) => t.created_at >= now - week);
      const working = issues.filter((t) => t.status === "in_progress" || t.status === "review");

      if (!issues.length && !epics().length) {
        el.replaceChildren(emptyState());
        return;
      }

      const tiles = h("div", { class: "stat-tiles" },
        tile("Open issues", open.length, `${plural(issues.length, "issue")} in total`),
        tile("In progress", working.length, "In Progress or In Review"),
        tile("Done", doneWeek.length, "in the last 7 days"),
        tile("Created", createdWeek.length, "in the last 7 days"),
        tile("Due soon", dueSoon.length, "in the next 7 days"),
        tile("Overdue", overdue.length, overdue.length ? "need attention" : "nothing late", overdue.length ? "alert" : null));

      // Status overview: one stacked bar with a 2px gap between segments, plus a labelled legend.
      const byStatus = STATUSES.map((s) => ({ s, n: issues.filter((t) => t.status === s.id).length }));
      const statusCard = card("Status overview", plural(issues.length, "issue"),
        h("div", { class: "stack-bar", role: "img", "aria-label": byStatus.map((x) => `${x.s.label} ${x.n}`).join(", ") },
          byStatus.filter((x) => x.n).map((x) => h("span", {
            class: `seg-fill s-${x.s.id}`,
            style: { flexGrow: String(x.n) },
            title: `${x.s.label}: ${x.n} (${Math.round((x.n / issues.length) * 100)}%)`,
          }))),
        h("ul", { class: "legend" }, byStatus.map((x) => h("li", null,
          h("span", { class: `swatch s-${x.s.id}` }),
          h("span", { class: "grow" }, x.s.label),
          h("strong", null, String(x.n)),
          h("span", { class: "muted small pct" }, issues.length ? `${Math.round((x.n / issues.length) * 100)}%` : "")))));

      const sprint = activeSprint();
      let sprintCard;
      if (sprint) {
        const si = issues.filter((t) => t.sprint_id === sprint.id);
        const sd = si.filter((t) => t.status === "done");
        const pts = si.reduce((a, t) => a + (t.estimate || 0), 0);
        const ptsDone = sd.reduce((a, t) => a + (t.estimate || 0), 0);
        const pct = si.length ? Math.round((sd.length / si.length) * 100) : 0;
        sprintCard = card(sprint.name, sprintRemaining(sprint),
          sprintMeta(sprint),
          h("div", { class: "big-progress" },
            h("div", { class: "progress lg", title: `${pct}% of issues done` }, h("span", { style: { width: pct + "%" } })),
            h("div", { class: "row" },
              h("span", null, h("strong", null, `${sd.length} of ${si.length}`), " issues done"),
              h("div", { class: "spacer" }),
              pts ? h("span", { class: "muted small" }, `${ptsDone} of ${pts} story points`) : null)),
          h("button", { class: "btn sm", onclick: () => setView("board") }, icon("board"), "Open board"));
      } else {
        sprintCard = card("Sprint", "none active",
          h("p", { class: "muted" }, "Group work into time-boxed sprints from the Backlog."),
          h("button", { class: "btn sm", onclick: () => setView("backlog") }, icon("backlog"), "Go to backlog"));
      }

      const prio = card("Priority breakdown", "open issues",
        bars(PRIORITIES.map((p) => ({ name: p.label, icon: priorityIcon(p.id), n: open.filter((t) => t.priority === p.id).length })), open.length));

      const types = card("Types of work", "all issues",
        bars(KINDS.filter((k) => k.id !== "epic").map((k) => ({ name: k.label, icon: kindIcon(k.id), n: issues.filter((t) => t.kind === k.id).length })), issues.length));

      const perAssignee = new Map();
      for (const t of open) {
        const k = t.assignee_id ?? 0;
        if (!perAssignee.has(k)) perAssignee.set(k, { name: t.assignee_name || "Unassigned", id: k, n: 0 });
        perAssignee.get(k).n++;
      }
      const workload = [...perAssignee.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
      const team = card("Team workload", "open issues per assignee",
        workload.length
          ? bars(workload.map((w) => ({
            name: w.name + (w.id === me.id ? " (you)" : ""),
            icon: w.id ? avatar({ id: w.id, display_name: w.name }) : h("span", { class: "avatar empty" }, icon("user")),
            n: w.n,
          })), open.length)
          : h("p", { class: "muted" }, "No open issues."));

      const epicRows = epics().map((e) => {
        const kids = S.data.tasks.filter((t) => t.parent_id === e.id);
        const done = kids.filter((t) => t.status === "done").length;
        const pct = kids.length ? Math.round((done / kids.length) * 100) : 0;
        return h("div", { class: "epic-row", onclick: () => openIssue(e), title: `${done} of ${kids.length} child issues done` },
          kindIcon("epic"),
          h("span", { class: "ellipsis grow" }, e.title),
          h("span", { class: "progress sm" }, h("span", { style: { width: pct + "%" } })),
          h("span", { class: "muted small num" }, `${done}/${kids.length}`));
      });
      const epicCard = card("Epic progress", plural(epicRows.length, "epic"),
        epicRows.length ? h("div", { class: "epic-rows" }, epicRows) : h("p", { class: "muted" }, "Epics group related issues, like the chapters of a thesis."));

      const feedCard = card("Recent activity", null,
        !feed
          ? h("div", { class: "muted small" }, "Loading…")
          : feed.length
            ? h("div", { class: "feed" }, feed.map((a) => {
              const t = S.byId.get(a.task_id);
              const subject = h("button", { class: "linkish", onclick: () => t && openIssue(t), title: a.title }, `${S.key}-${a.num}`);
              return h("div", { class: "act" },
                avatar({ id: a.user_id || 0, display_name: a.name || "?" }),
                h("div", { class: "grow" }, activityText(a, subject), h("div", { class: "muted small" }, a.title, " · ", timeAgo(a.created_at))));
            }))
            : h("p", { class: "muted" }, "Nothing has happened yet."));

      el.replaceChildren(tiles,
        h("div", { class: "sum-grid" }, statusCard, sprintCard, prio, types, team, epicCard, feedCard));
    }
    return { el, render };
  }

  // ------------------------------------------------------------------ settings
  function settingsDialog() {
    const key = h("input", { type: "text", maxlength: 10, disabled: !S.canEdit, style: { textTransform: "uppercase" } });
    key.value = S.key;
    const err = h("div", { class: "form-error" });
    const save = async () => {
      err.textContent = "";
      try {
        const r = await patch(`/api/projects/${pid}/board`, { key: key.value });
        S.key = r.key;
        S.data.project.key = r.key;
        m.close();
        toast(`Issues are now numbered ${r.key}-1, ${r.key}-2, …`, "success");
        render();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    const m = modal({
      title: "Board settings",
      body: h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); if (S.canEdit) save(); } },
        h("label", null, "Issue key"), key,
        h("p", { class: "muted small" }, "Issues are numbered with this prefix, like ", h("strong", null, `${S.key}-1`), ". Changing it renames every issue of this project."),
        h("label", null, "Team"),
        h("div", { class: "team-list" }, S.data.members.map((u) => h("div", { class: "member" },
          avatar({ id: u.id, display_name: u.display_name }),
          h("div", { class: "grow" }, u.display_name, u.id === me.id ? h("span", { class: "muted" }, " (you)") : null, h("div", { class: "muted small" }, "@" + u.username)),
          h("span", { class: `role-badge ${u.role}` }, u.role)))),
        h("p", { class: "muted small" }, "Issues can be assigned to anyone on the team. Add people with ", h("strong", null, "Share"), " in the editor."),
        err),
      actions: S.canEdit
        ? [h("button", { class: "btn", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onclick: save }, "Save")]
        : [h("button", { class: "btn", onclick: () => m.close() }, "Close")],
    });
  }

  // ------------------------------------------------------------------ live updates
  function scheduleReload(m) {
    if (m && S.dialog && m.task === S.dialog.id && m.by !== me.id) S.dialog.refresh();
    clearTimeout(S.reloadTimer);
    S.reloadTimer = setTimeout(reload, 250);
  }

  async function reload() {
    if (S.destroyed) return;
    if (S.dragging) {
      S.pendingReload = true;
      return;
    }
    try {
      await load();
    } catch (e) {
      if (e.status === 404) return gone();
      return toast(e.message, "error");
    }
    render();
  }

  function gone() {
    if (S.destroyed) return;
    toast("This project was deleted or you no longer have access to it.", "warn");
    ctx.navigate("/");
  }

  function renderPresence() {
    const seen = new Set();
    const others = [];
    for (const u of S.presence) {
      if (u.conn === S.conn || seen.has(u.user_id)) continue;
      seen.add(u.user_id);
      others.push(u);
    }
    E.online.replaceChildren(...others.slice(0, 6).map((u) => avatar(u, { title: `${u.name} is online`, style: { background: colorFor(u.user_id) } })));
    if (others.length > 6) E.online.append(h("span", { class: "muted small", style: { marginLeft: "6px" } }, `+${others.length - 6}`));
  }

  let everConnected = false;
  const socket = new ProjectSocket(pid, (m) => {
    if (S.destroyed) return;
    switch (m.t) {
      case "hello":
        S.conn = m.conn;
        break;
      case "presence":
        S.presence = m.users || [];
        renderPresence();
        break;
      case "tasks":
        scheduleReload(m);
        break;
      case "task_assigned":
        taskNotice(m, me);
        break;
      case "project":
        // Renamed, or membership changed (which can change our role or the assignees).
        scheduleReload();
        break;
      case "project_deleted":
        gone();
        break;
      default:
        break;
    }
  }, (state) => {
    if (S.destroyed) return;
    const up = state === "open";
    E.connDot.classList.toggle("off", !up);
    E.connDot.title = up ? "Live: changes by others appear automatically" : "Disconnected, reconnecting…";
    if (up) {
      if (everConnected) scheduleReload();
      everConnected = true;
    } else {
      get(`/api/projects/${pid}/tasks`).catch((e) => e.status === 404 && gone());
    }
  });

  // ------------------------------------------------------------------ keyboard
  const onKey = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector(".modal-overlay, .ctx-menu")) return;
    if (e.key === "c" && S.canEdit) {
      e.preventDefault();
      createIssue();
    } else if (e.key === "/" && E.search && !E.filters.classList.contains("hidden")) {
      e.preventDefault();
      E.search.focus();
    }
  };
  window.addEventListener("keydown", onKey);

  // ------------------------------------------------------------------ init
  render();
  syncDialog();

  return {
    /** Handle back/forward between views of this project without rebuilding the page. */
    reroute(path) {
      const r = matchTasksPath(path);
      if (!r || r[0] !== pid) return false;
      if (r[1] !== S.view) {
        S.view = r[1];
        S.quick = null;
        render();
      }
      syncDialog();
      return true;
    },
    destroy() {
      S.destroyed = true;
      clearTimeout(S.reloadTimer);
      socket.close();
      window.removeEventListener("keydown", onKey);
      if (S.dialog) S.dialog.close();
      document.querySelectorAll(".ctx-menu, .modal-overlay").forEach((x) => x.remove());
    },
  };
}
