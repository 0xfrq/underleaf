// Shared pieces of the task tracker: issue types, workflow, priorities, dates and small widgets.

import { h, icon, avatar, colorFor, contextMenu, toast } from "./ui.js";

export const STATUSES = [
  { id: "todo", label: "To Do" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "In Review" },
  { id: "done", label: "Done" },
];

export const KINDS = [
  { id: "task", label: "Task" },
  { id: "story", label: "Story" },
  { id: "bug", label: "Bug" },
  { id: "epic", label: "Epic" },
];

export const PRIORITIES = [
  { id: "highest", label: "Highest" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
  { id: "lowest", label: "Lowest" },
];

const rankOf = (list) => Object.fromEntries(list.map((x, i) => [x.id, i]));
export const STATUS_RANK = rankOf(STATUSES);
export const KIND_RANK = rankOf(KINDS);
export const PRIORITY_RANK = rankOf(PRIORITIES);

const labelOf = (list, id) => (list.find((x) => x.id === id) || { label: id }).label;
export const statusLabel = (s) => labelOf(STATUSES, s);
export const kindLabel = (k) => labelOf(KINDS, k);
export const priorityLabel = (p) => labelOf(PRIORITIES, p);

export const options = (list) => list.map((x) => h("option", { value: x.id }, x.label));

/** Set a <select>'s value, falling back to the first option if the value is not offered. */
export function setSelect(sel, value) {
  sel.value = value == null ? "" : String(value);
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;
}

// ---------------------------------------------------------------------------
// Icons

const KIND_SVG = {
  task: '<rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor"/><path d="m7.5 12.3 3 3 6-6.6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  story: '<rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor"/><path d="M8.5 6.5h7v11l-3.5-2.8-3.5 2.8z" fill="#fff"/>',
  bug: '<rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor"/><circle cx="12" cy="12" r="4.6" fill="#fff"/>',
  epic: '<rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor"/><path d="M13.4 5 7.6 13.2h4.1l-1.1 5.8 5.8-8.2h-4.1z" fill="#fff"/>',
};

export function kindIcon(kind) {
  const s = document.createElement("span");
  s.className = `kind-ico k-${kind}`;
  s.title = kindLabel(kind);
  s.innerHTML = `<svg viewBox="0 0 24 24">${KIND_SVG[kind] || KIND_SVG.task}</svg>`;
  return s;
}

const PRIO_SVG = {
  highest: '<path d="m6 12.5 6-5 6 5M6 18l6-5 6 5"/>',
  high: '<path d="m6 15 6-6 6 6"/>',
  medium: '<path d="M6 9.5h12M6 14.5h12"/>',
  low: '<path d="m6 9 6 6 6-6"/>',
  lowest: '<path d="m6 6 6 5 6-5M6 11.5l6 5 6-5"/>',
};

export function priorityIcon(p) {
  const s = document.createElement("span");
  s.className = `prio-ico p-${p}`;
  s.title = `${priorityLabel(p)} priority`;
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${PRIO_SVG[p] || PRIO_SVG.medium}</svg>`;
  return s;
}

// ---------------------------------------------------------------------------
// Small widgets

export const statusPill = (status) => h("span", { class: `status-pill s-${status}` }, statusLabel(status));

/** A status pill that, when allowed, opens a menu to move the issue through the workflow. */
export function statusPicker(status, enabled, onPick) {
  if (!enabled) return statusPill(status);
  const el = h("button", { type: "button", class: `status-pill s-${status} pick`, title: "Change status" }, statusLabel(status), h("span", { class: "caret" }, "▾"));
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, STATUSES.map((s) => ({
      label: h("span", { class: "row" }, statusPill(s.id), s.id === status ? icon("check") : null),
      action: () => s.id !== status && onPick(s.id),
    })));
  });
  return el;
}

export function assigneeAvatar(t) {
  return t.assignee_id
    ? avatar({ id: t.assignee_id, display_name: t.assignee_name || "?" }, { title: `Assignee: ${t.assignee_name || "unknown"}` })
    : h("span", { class: "avatar empty", title: "Unassigned" }, icon("user"));
}

export function epicChip(epic) {
  if (!epic) return null;
  const el = h("span", { class: "epic-chip", title: `Epic: ${epic.title}` }, epic.title);
  el.style.setProperty("--c", colorFor(epic.id));
  return el;
}

export const labelChips = (labels) => (labels || []).map((l) => h("span", { class: "label-chip" }, l));

export function points(t) {
  return t.estimate == null ? null : h("span", { class: "points", title: "Story points" }, String(t.estimate));
}

// ---------------------------------------------------------------------------
// Dates. Due and start dates are plain YYYY-MM-DD strings in the user's local calendar.

const pad = (n) => String(n).padStart(2, "0");
export const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => dateStr(new Date());

export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export const dayDiff = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);

export function fmtDate(s, withYear = false) {
  const d = parseDate(s);
  const o = { month: "short", day: "numeric" };
  if (withYear || d.getFullYear() !== new Date().getFullYear()) o.year = "numeric";
  return d.toLocaleDateString(undefined, o);
}

export const isOverdue = (t) => !!t.due_date && t.status !== "done" && t.due_date < today();

export function dueBadge(t) {
  if (!t.due_date) return null;
  const diff = dayDiff(today(), t.due_date);
  const open = t.status !== "done";
  let cls = "due";
  if (open && diff < 0) cls += " overdue";
  else if (open && diff <= 2) cls += " soon";
  const text = open && diff === 0 ? "Today" : open && diff === 1 ? "Tomorrow" : fmtDate(t.due_date);
  const late = open && diff < 0 ? ` (${-diff} day${diff === -1 ? "" : "s"} overdue)` : "";
  return h("span", { class: cls, title: `Due ${fmtDate(t.due_date, true)}${late}` }, icon("clock"), text);
}

export function sprintDates(s) {
  if (!s.start_date || !s.end_date) return "";
  return `${fmtDate(s.start_date)} – ${fmtDate(s.end_date)}`;
}

/** "5 days left", "ends today", "ended 2 days ago". */
export function sprintRemaining(s) {
  if (!s.end_date) return "";
  const d = dayDiff(today(), s.end_date);
  if (d > 0) return `${d} day${d === 1 ? "" : "s"} left`;
  if (d === 0) return "ends today";
  return `ended ${-d} day${d === -1 ? "" : "s"} ago`;
}

// ---------------------------------------------------------------------------
// Text

/** Plain text with http(s) links made clickable. Never parses HTML. */
export function richText(text) {
  const frag = document.createDocumentFragment();
  const re = /\bhttps?:\/\/[^\s<>"']+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    frag.append(text.slice(last, m.index), h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
    last = m.index + url.length;
    re.lastIndex = last;
  }
  frag.append(text.slice(last));
  return frag;
}

const FIELD_NAMES = {
  title: "Summary",
  kind: "Type",
  status: "Status",
  priority: "Priority",
  description: "Description",
  assignee: "Assignee",
  sprint: "Sprint",
  parent: "Epic",
  start_date: "Start date",
  due_date: "Due date",
  estimate: "Story points",
  labels: "Labels",
};

function fieldValue(field, v) {
  if (v == null || v === "") return h("span", { class: "muted" }, "None");
  if (field === "status") return statusPill(v);
  if (field === "kind") return h("span", { class: "row tight" }, kindIcon(v), kindLabel(v));
  if (field === "priority") return h("span", { class: "row tight" }, priorityIcon(v), priorityLabel(v));
  if (field === "start_date" || field === "due_date") return fmtDate(v, true);
  return v;
}

/**
 * One history entry: "<verb>" and, for field changes, "old → new".
 * `subject` (optional) names the issue, e.g. in the project-wide feed.
 */
export function activityText(a, subject) {
  let verb;
  if (a.field === "created") verb = "created";
  else if (a.field === "comment") verb = "commented on";
  else verb = `changed ${FIELD_NAMES[a.field] || a.field}${subject ? " of" : ""}`;
  const line = h("div", { class: "act-line" },
    h("strong", null, a.name || "Former user"), " ", verb,
    subject ? [" ", subject] : a.field === "created" ? " the issue" : a.field === "comment" ? " this issue" : null);
  const change = a.field in FIELD_NAMES && a.field !== "description"
    ? h("div", { class: "act-change" }, fieldValue(a.field, a.old), h("span", { class: "muted" }, "→"), fieldValue(a.field, a.new))
    : null;
  return [line, change];
}

/** Notify the current user when someone assigns them an issue in a project they have open. */
export function taskNotice(m, me) {
  if (m.t === "task_assigned" && m.to === me.id && m.by !== me.id) {
    toast(`${m.by_name} assigned you ${m.key}: ${m.title}`, "info", 6000);
  }
}

/** The context the "Create issue" dialog needs, from a board response. */
export function boardContext(d) {
  return {
    project: d.project,
    members: d.members,
    sprints: d.sprints,
    epics: d.tasks.filter((t) => t.kind === "epic"),
  };
}
