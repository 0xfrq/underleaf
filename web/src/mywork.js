// "My work": the issues assigned to or reported by the current user, across all projects.

import { get, patch } from "./api.js";
import { h, icon, toast, loadLS, saveLS } from "./ui.js";
import { topNav, userMenuButton } from "./dashboard.js";
import { kindIcon, priorityIcon, statusPicker, dueBadge, assigneeAvatar, today, addDays } from "./tasks-common.js";
import { openTask, openCreate } from "./task-dialog.js";
import { taskCalendar } from "./task-calendar.js";

export async function renderMyWork(root, ctx) {
  const me = ctx.me;
  const S = {
    tasks: [],
    projects: new Map(),
    tab: loadLS("ul:mw-tab", "assigned"),
    mode: loadLS("ul:mw-mode", "list"),
    q: "",
    dialog: null,
    destroyed: false,
  };

  const nav = topNav(ctx, "work");
  const content = h("div", { class: "mw-content" });
  const search = h("input", { type: "search", placeholder: "Search my issues…", oninput: () => { S.q = search.value.trim().toLowerCase(); draw(); } });
  const tabs = h("div", { class: "seg" });
  const modes = h("div", { class: "seg" });
  const createBtn = h("button", { class: "btn primary", onclick: () => create() }, icon("plus"), "Create issue");

  root.append(h("div", { class: "dash" },
    h("header", { class: "topbar" }, nav, h("div", { class: "spacer" }), userMenuButton(ctx)),
    h("div", { class: "dash-body wide" },
      h("div", { class: "dash-head" }, h("h1", null, "My work"), h("div", { class: "spacer" }), search, createBtn),
      h("div", { class: "mw-bar" }, tabs, h("div", { class: "spacer" }), modes),
      content)));
  document.title = "My work - Underleaf";

  const project = (t) => S.projects.get(t.project_id) || { name: "?", key: "?", role: "viewer" };
  const keyOf = (t) => `${project(t).key}-${t.num}`;
  const canEditIn = (t) => project(t).role !== "viewer";
  const canMove = (t) => canEditIn(t) || t.assignee_id === me.id;

  async function load() {
    const r = await get("/api/tasks");
    S.tasks = r.tasks;
    S.projects = new Map(r.projects.map((p) => [p.id, p]));
    nav.setCount(S.tasks.filter((t) => t.assignee_id === me.id && t.status !== "done").length);
  }

  function shown() {
    return S.tasks.filter((t) => (S.tab === "assigned" ? t.assignee_id === me.id : t.reporter_id === me.id)
      && (!S.q || t.title.toLowerCase().includes(S.q) || keyOf(t).toLowerCase().includes(S.q) || project(t).name.toLowerCase().includes(S.q)));
  }

  async function update(t, body) {
    try {
      await patch(`/api/projects/${t.project_id}/tasks/${t.id}`, body);
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function refresh() {
    try {
      await load();
    } catch (e) {
      return toast(e.message, "error");
    }
    if (!S.destroyed) draw();
  }

  function open(t) {
    if (S.dialog) S.dialog.close();
    const dlg = openTask({
      pid: t.project_id,
      id: t.id,
      me,
      onChange: () => refresh(),
      onClose: () => {
        if (S.dialog === dlg) S.dialog = null;
      },
    });
    S.dialog = dlg;
  }

  function create(defaults = {}) {
    openCreate({
      projects: [...S.projects.values()],
      defaults: { assignee_id: me.id, ...defaults },
      me,
      onCreated: () => refresh(),
    });
  }

  function row(t) {
    const p = project(t);
    return h("div", { class: "work-row" + (t.status === "done" ? " done" : ""), tabindex: 0, onclick: () => open(t), onkeydown: (e) => e.key === "Enter" && open(t) },
      kindIcon(t.kind),
      h("span", { class: "card-key" }, keyOf(t)),
      h("span", { class: "work-title" }, h("span", { class: "ellipsis" }, t.title),
        h("a", { class: "work-project", href: `/project/${t.project_id}/board`, "data-link": "", title: "Open the project's board", onclick: (e) => e.stopPropagation() }, p.name)),
      dueBadge(t),
      statusPicker(t.status, canMove(t), (s) => update(t, { status: s })),
      priorityIcon(t.priority),
      assigneeAvatar(t));
  }

  let calendar = null;

  function draw() {
    const list = shown();
    const count = (tab) => S.tasks.filter((t) => (tab === "assigned" ? t.assignee_id === me.id : t.reporter_id === me.id) && t.status !== "done").length;
    tabs.replaceChildren(
      h("button", { class: "btn sm" + (S.tab === "assigned" ? " on" : ""), onclick: () => setTab("assigned") }, "Assigned to me", h("span", { class: "count" }, String(count("assigned")))),
      h("button", { class: "btn sm" + (S.tab === "reported" ? " on" : ""), onclick: () => setTab("reported") }, "Reported by me", h("span", { class: "count" }, String(count("reported")))));
    modes.replaceChildren(
      h("button", { class: "btn sm" + (S.mode === "list" ? " on" : ""), onclick: () => setMode("list") }, icon("list"), "List"),
      h("button", { class: "btn sm" + (S.mode === "calendar" ? " on" : ""), onclick: () => setMode("calendar") }, icon("calendar"), "Calendar"));
    const writable = [...S.projects.values()].some((p) => p.role !== "viewer");
    createBtn.disabled = !writable;
    createBtn.title = writable ? "" : "You need edit access to a project to create issues";

    if (S.mode === "calendar") {
      if (!calendar) {
        calendar = taskCalendar({
          tasks: shown,
          keyOf,
          subtitle: (t) => project(t).name,
          onOpen: open,
          canMove: canEditIn,
          onMove: (t, date) => {
            const body = { due_date: date };
            if (date && t.start_date && t.start_date > date) body.start_date = date;
            update(t, body);
          },
          canCreate: () => writable,
          onCreate: (date) => create({ due_date: date }),
        });
      }
      if (content.firstChild !== calendar.el) content.replaceChildren(calendar.el);
      calendar.render();
      return;
    }

    if (!S.tasks.length) {
      content.replaceChildren(h("div", { class: "empty-state" },
        h("h3", null, "Nothing on your plate"),
        h("p", null, "Issues assigned to you or reported by you in any project show up here."),
        writable ? h("button", { class: "btn primary", onclick: () => create() }, icon("plus"), "Create issue") : null));
      return;
    }

    const t0 = today();
    const week = addDays(t0, 7);
    const groups = [
      { label: "Overdue", tone: "alert", test: (t) => t.status !== "done" && t.due_date && t.due_date < t0 },
      { label: "Due today", test: (t) => t.status !== "done" && t.due_date === t0 },
      { label: "Due in the next 7 days", test: (t) => t.status !== "done" && t.due_date > t0 && t.due_date <= week },
      { label: "Due later", test: (t) => t.status !== "done" && t.due_date > week },
      { label: "No due date", test: (t) => t.status !== "done" && !t.due_date },
    ];
    const byDue = (a, b) => (a.due_date || "").localeCompare(b.due_date || "") || b.updated_at - a.updated_at;
    const sections = groups.map((g) => {
      const items = list.filter(g.test).sort(byDue);
      if (!items.length) return null;
      return h("section", { class: "work-group" + (g.tone ? ` ${g.tone}` : "") },
        h("header", null, h("strong", null, g.label), h("span", { class: "muted small" }, String(items.length))),
        items.map(row));
    }).filter(Boolean);
    const done = list.filter((t) => t.status === "done").sort((a, b) => (b.resolved_at || 0) - (a.resolved_at || 0));
    if (done.length) {
      sections.push(h("details", { class: "work-group", open: !!S.doneOpen, ontoggle: (e) => (S.doneOpen = e.currentTarget.open) },
        h("summary", null, h("strong", null, "Done in the last 30 days"), h("span", { class: "muted small" }, String(done.length))),
        done.map(row)));
    }
    content.replaceChildren(...(sections.length
      ? sections
      : [h("div", { class: "empty-state" }, h("h3", null, S.q ? "No matching issues" : "All clear"), h("p", null, S.q ? "Try another search." : S.tab === "assigned" ? "Nothing is assigned to you right now." : "You have not reported any open issues."))]));
  }

  function setTab(tab) {
    S.tab = tab;
    saveLS("ul:mw-tab", tab);
    draw();
  }

  function setMode(mode) {
    S.mode = mode;
    saveLS("ul:mw-mode", mode);
    draw();
  }

  await load();
  draw();
  return {
    destroy() {
      S.destroyed = true;
      if (S.dialog) S.dialog.close();
      document.querySelectorAll(".ctx-menu, .modal-overlay").forEach((x) => x.remove());
    },
  };
}
