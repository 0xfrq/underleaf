// Month calendar of issues by due date. Drag an issue to another day to reschedule it, or onto
// the "Unscheduled" list to clear its due date.

import { h, icon, modal, loadLS, saveLS } from "./ui.js";
import { kindIcon, dateStr, today, isOverdue, fmtDate, PRIORITY_RANK } from "./tasks-common.js";

const MAX_CHIPS = 3;

/**
 * opts:
 *   tasks()          issues to show (already filtered)
 *   keyOf(t)         "KEY-12"
 *   subtitle(t)      optional extra tooltip text, e.g. the project name
 *   onOpen(t)
 *   canMove(t)       may `t` be rescheduled?
 *   onMove(t, date)  date is "YYYY-MM-DD" or null
 *   canCreate()      show "+" buttons on days?
 *   onCreate(date)
 * Returns { el, render() }.
 */
export function taskCalendar(opts) {
  let cursor = new Date();
  cursor.setDate(1);
  let dragging = null;
  let showSide = loadLS("ul:cal-side", true);

  const title = h("h2", { class: "cal-title" });
  const grid = h("div", { class: "cal-grid" });
  const side = h("aside", { class: "cal-side" });
  const sideBtn = h("button", { class: "btn sm", onclick: () => { showSide = !showSide; saveLS("ul:cal-side", showSide); render(); } }, "Unscheduled");
  const wrap = h("div", { class: "cal-wrap" }, grid, side);
  const el = h("div", { class: "cal" },
    h("div", { class: "view-head" },
      h("div", { class: "row" },
        h("button", { class: "icon-btn", title: "Previous month", onclick: () => shift(-1) }, icon("back")),
        h("button", { class: "icon-btn flip", title: "Next month", onclick: () => shift(1) }, icon("back")),
        title),
      h("button", { class: "btn sm", onclick: () => { cursor = new Date(); cursor.setDate(1); render(); } }, "Today"),
      h("div", { class: "spacer" }),
      sideBtn),
    wrap);

  function shift(n) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + n, 1);
    render();
  }

  const byUrgency = (a, b) =>
    (a.status === "done") - (b.status === "done") || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.num - b.num;

  function chip(t) {
    const movable = opts.canMove(t);
    const tip = `${opts.keyOf(t)} ${t.title}` + (opts.subtitle ? ` · ${opts.subtitle(t)}` : "");
    const c = h("div", {
      class: `cal-chip s-${t.status}` + (isOverdue(t) ? " overdue" : ""),
      draggable: movable ? "true" : "false",
      title: tip,
      tabindex: 0,
      onclick: () => opts.onOpen(t),
      onkeydown: (e) => e.key === "Enter" && opts.onOpen(t),
    }, kindIcon(t.kind), h("span", { class: "k" }, opts.keyOf(t)), h("span", { class: "t" }, t.title));
    if (movable) {
      c.addEventListener("dragstart", (e) => {
        dragging = t;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", opts.keyOf(t));
        requestAnimationFrame(() => c.classList.add("dragging"));
      });
      c.addEventListener("dragend", () => {
        dragging = null;
        c.classList.remove("dragging");
        el.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
      });
    }
    return c;
  }

  function dropTarget(target, date) {
    target.addEventListener("dragover", (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      target.classList.add("drop");
    });
    target.addEventListener("dragleave", (e) => {
      if (!target.contains(e.relatedTarget)) target.classList.remove("drop");
    });
    target.addEventListener("drop", (e) => {
      if (!dragging) return;
      e.preventDefault();
      target.classList.remove("drop");
      const t = dragging;
      dragging = null;
      if ((t.due_date || null) !== date) opts.onMove(t, date);
    });
  }

  function dayList(date, items) {
    const m = modal({
      title: fmtDate(date, true),
      body: h("div", { class: "cal-daylist" }, items.map((t) => {
        const c = chip(t);
        c.draggable = false;
        c.addEventListener("click", () => m.close(), true);
        return c;
      })),
    });
  }

  function render() {
    title.textContent = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const tasks = opts.tasks();
    const byDay = new Map();
    for (const t of tasks) {
      if (!t.due_date) continue;
      if (!byDay.has(t.due_date)) byDay.set(t.due_date, []);
      byDay.get(t.due_date).push(t);
    }

    // Weeks start on Monday.
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const startD = new Date(first);
    startD.setDate(1 - ((first.getDay() + 6) % 7));
    const endD = new Date(last);
    endD.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));
    const todayS = today();
    const creatable = opts.canCreate && opts.canCreate();

    const cells = [];
    for (let i = 0; i < 7; i++) {
      // 1 Jan 2024 was a Monday.
      cells.push(h("div", { class: "cal-dow" }, new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" })));
    }
    for (const d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const ds = dateStr(d);
      const items = (byDay.get(ds) || []).sort(byUrgency);
      const cls = ["cal-cell"];
      if (d.getMonth() !== cursor.getMonth()) cls.push("other");
      if (ds === todayS) cls.push("today");
      if (d.getDay() === 0 || d.getDay() === 6) cls.push("weekend");
      const label = d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : String(d.getDate());
      const cell = h("div", { class: cls.join(" ") },
        h("div", { class: "cal-day" },
          h("span", { class: "num" }, label),
          creatable ? h("button", { class: "icon-btn add", title: `Create an issue due ${fmtDate(ds, true)}`, onclick: () => opts.onCreate(ds) }, icon("plus")) : null),
        items.slice(0, MAX_CHIPS).map(chip),
        items.length > MAX_CHIPS ? h("button", { class: "cal-more", onclick: () => dayList(ds, items) }, `+${items.length - MAX_CHIPS} more`) : null);
      dropTarget(cell, ds);
      cells.push(cell);
    }
    grid.replaceChildren(...cells);

    wrap.classList.toggle("no-side", !showSide);
    sideBtn.classList.toggle("on", showSide);
    const unscheduled = tasks.filter((t) => !t.due_date && t.status !== "done").sort(byUrgency);
    sideBtn.replaceChildren("Unscheduled", h("span", { class: "count" }, String(unscheduled.length)));
    side.replaceChildren(
      h("div", { class: "cal-side-head" }, h("strong", null, "Unscheduled"), h("span", { class: "muted small" }, "Drag onto a day to set the due date")),
      unscheduled.length
        ? h("div", { class: "cal-side-list" }, unscheduled.slice(0, 200).map(chip))
        : h("p", { class: "muted small" }, "Every open issue has a due date."));
    if (!side.dataset.drop) {
      side.dataset.drop = "1";
      dropTarget(side, null);
    }
  }

  return { el, render };
}
