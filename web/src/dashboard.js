import { get, post, patch, del } from "./api.js";
import { h, icon, logo, toast, modal, promptDialog, confirmDialog, contextMenu, avatar, timeAgo } from "./ui.js";

export function userMenuButton(ctx) {
  const me = ctx.me;
  const btn = h("button", { class: "btn ghost user-btn", title: me.username }, avatar({ id: me.id, display_name: me.display_name }), h("span", { class: "hide-narrow" }, me.display_name));
  btn.addEventListener("click", () => {
    const r = btn.getBoundingClientRect();
    contextMenu(r.right - 180, r.bottom + 4, [
      { label: "Profile", action: () => profileDialog(ctx) },
      { label: "Change password", action: () => passwordDialog() },
      me.is_admin ? { label: "Manage users", action: () => usersDialog(ctx) } : null,
      "-",
      { label: "Log out", action: () => ctx.logout() },
    ]);
  });
  return btn;
}

function profileDialog(ctx) {
  const input = h("input", { type: "text" });
  input.value = ctx.me.display_name;
  const err = h("div", { class: "form-error" });
  const save = async () => {
    try {
      const r = await patch("/api/auth/me", { display_name: input.value });
      ctx.setMe({ ...ctx.me, display_name: r.display_name });
      m.close();
      toast("Profile updated", "success");
      ctx.navigate(location.pathname, true);
    } catch (e) {
      err.textContent = e.message;
    }
  };
  const m = modal({
    title: "Profile",
    body: h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); save(); } }, h("label", null, "Display name (shown to collaborators)"), input, err),
    actions: [h("button", { class: "btn", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onclick: save }, "Save")],
  });
}

function passwordDialog() {
  const oldPw = h("input", { type: "password", autocomplete: "current-password" });
  const newPw = h("input", { type: "password", autocomplete: "new-password" });
  const err = h("div", { class: "form-error" });
  const save = async () => {
    try {
      await post("/api/auth/password", { old_password: oldPw.value, new_password: newPw.value });
      m.close();
      toast("Password changed. Other sessions were logged out.", "success");
    } catch (e) {
      err.textContent = e.message;
    }
  };
  const m = modal({
    title: "Change password",
    body: h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); save(); } },
      h("label", null, "Current password"), oldPw, h("label", null, "New password (min. 8 characters)"), newPw, err),
    actions: [h("button", { class: "btn", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onclick: save }, "Change password")],
  });
}

function usersDialog(ctx) {
  const tbody = h("tbody");
  const err = h("div", { class: "form-error" });
  const uname = h("input", { type: "text", placeholder: "username" });
  const pw = h("input", { type: "password", placeholder: "password", autocomplete: "new-password" });
  const isAdmin = h("input", { type: "checkbox" });
  async function load() {
    const users = await get("/api/admin/users");
    tbody.replaceChildren(...users.map((u) => h("tr", null,
      h("td", null, h("strong", null, u.username), u.is_admin ? h("span", { class: "role-badge owner", style: { marginLeft: "6px" } }, "admin") : null),
      h("td", null, u.display_name),
      h("td", { class: "muted" }, String(u.projects)),
      h("td", { style: { textAlign: "right" } }, u.id === ctx.me.id ? null : h("button", {
        class: "btn sm danger",
        onclick: async () => {
          if (!(await confirmDialog("Delete user", `Delete ${u.username} and all ${u.projects} project(s) they own? This cannot be undone.`, { okText: "Delete", danger: true }))) return;
          try {
            await del(`/api/admin/users/${u.id}`);
            load();
          } catch (e) {
            toast(e.message, "error");
          }
        },
      }, "Delete")))));
  }
  const create = async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      await post("/api/admin/users", { username: uname.value.trim(), password: pw.value, is_admin: isAdmin.checked });
      uname.value = "";
      pw.value = "";
      isAdmin.checked = false;
      load();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
  modal({
    title: "Users",
    wide: true,
    body: h("div", null,
      h("table", { class: "user-table" }, h("thead", null, h("tr", null, h("th", null, "Username"), h("th", null, "Name"), h("th", null, "Projects"), h("th"))), tbody),
      h("h3", { style: { margin: "18px 0 4px", fontSize: "14px" } }, "Create user"),
      h("form", { class: "row", onsubmit: create }, uname, pw,
        h("label", { class: "row", style: { margin: 0, whiteSpace: "nowrap" } }, isAdmin, "admin"),
        h("button", { class: "btn primary", type: "submit" }, "Create")),
      err),
  });
  load().catch((e) => (err.textContent = e.message));
}

// ---------------------------------------------------------------------------

export async function renderDashboard(root, ctx) {
  let projects = [];
  const list = h("div");
  const search = h("input", { type: "search", placeholder: "Search projects…", oninput: () => draw() });
  const fileInput = h("input", { type: "file", accept: ".zip,application/zip", class: "hidden", onchange: () => importZip() });

  const page = h("div", { class: "dash" },
    h("header", { class: "topbar" }, h("span", { class: "brand" }, logo(), "Underleaf"), h("div", { class: "spacer" }), userMenuButton(ctx)),
    h("div", { class: "dash-body" },
      h("div", { class: "dash-head" },
        h("h1", null, "Projects"),
        h("div", { class: "spacer" }),
        search,
        h("button", { class: "btn", onclick: () => fileInput.click() }, icon("upload"), "Upload .zip"),
        h("button", { class: "btn primary", onclick: newProject }, icon("newFile"), "New project"),
        fileInput),
      list));
  root.append(page);

  async function load() {
    projects = await get("/api/projects");
    draw();
  }

  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.owner.toLowerCase().includes(q));
    if (!projects.length) {
      list.replaceChildren(h("div", { class: "empty-state" },
        h("h3", null, "No projects yet"),
        h("p", null, "Create a new project or upload a .zip of an existing LaTeX project."),
        h("button", { class: "btn primary", onclick: newProject }, "New project")));
      return;
    }
    list.replaceChildren(h("table", { class: "project-table" },
      h("thead", null, h("tr", null, h("th", null, "Name"), h("th", { class: "col-owner" }, "Owner"), h("th", { class: "col-role" }, "Access"), h("th", null, "Last modified"), h("th"))),
      h("tbody", null, shown.map((p) => h("tr", null,
        h("td", { class: "pname-cell" }, h("a", { href: `/project/${p.id}`, "data-link": "" }, p.name)),
        h("td", { class: "col-owner muted" }, p.owner),
        h("td", { class: "col-role" }, h("span", { class: `role-badge ${p.role}` }, p.role)),
        h("td", { class: "muted" }, timeAgo(p.updated_at)),
        h("td", { class: "actions" }, h("button", { class: "icon-btn", title: "Actions", onclick: (e) => projectMenu(e, p) }, icon("more"))))))));
  }

  function projectMenu(e, p) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.right - 170, r.bottom + 2, [
      { label: "Open", action: () => ctx.navigate(`/project/${p.id}`) },
      p.role !== "viewer" ? { label: "Rename", action: () => rename(p) } : null,
      { label: "Make a copy", action: () => copy(p) },
      { label: "Download .zip", action: () => (location.href = `/api/projects/${p.id}/download`) },
      "-",
      p.role === "owner"
        ? { label: "Delete", danger: true, action: () => remove(p) }
        : { label: "Leave project", danger: true, action: () => leave(p) },
    ]);
  }

  async function newProject() {
    const name = h("input", { type: "text", placeholder: "My paper" });
    const tpl = h("select", null,
      h("option", { value: "article" }, "Article"),
      h("option", { value: "report" }, "Report / thesis"),
      h("option", { value: "beamer" }, "Beamer presentation"),
      h("option", { value: "blank" }, "Blank"));
    const err = h("div", { class: "form-error" });
    const create = async () => {
      if (!name.value.trim()) {
        err.textContent = "Please enter a name";
        return;
      }
      try {
        const r = await post("/api/projects", { name: name.value.trim(), template: tpl.value });
        m.close();
        ctx.navigate(`/project/${r.id}`);
      } catch (e) {
        err.textContent = e.message;
      }
    };
    const m = modal({
      title: "New project",
      body: h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); create(); } }, h("label", null, "Project name"), name, h("label", null, "Template"), tpl, err),
      actions: [h("button", { class: "btn", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onclick: create }, "Create")],
    });
  }

  async function importZip() {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file, file.name);
    toast(`Uploading ${file.name}…`);
    try {
      const r = await post("/api/projects/import", fd);
      ctx.navigate(`/project/${r.id}`);
    } catch (e) {
      toast(`Import failed: ${e.message}`, "error");
    }
  }

  async function rename(p) {
    const name = await promptDialog("Rename project", { value: p.name, okText: "Rename", selectStem: false });
    if (!name || name === p.name) return;
    try {
      await patch(`/api/projects/${p.id}`, { name });
      load();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function copy(p) {
    const name = await promptDialog("Copy project", { value: `${p.name} (copy)`, okText: "Copy", selectStem: false });
    if (!name) return;
    try {
      await post(`/api/projects/${p.id}/copy`, { name });
      toast("Project copied", "success");
      load();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function remove(p) {
    if (!(await confirmDialog("Delete project", `Delete "${p.name}" permanently? This cannot be undone.`, { okText: "Delete", danger: true }))) return;
    try {
      await del(`/api/projects/${p.id}`);
      load();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function leave(p) {
    if (!(await confirmDialog("Leave project", `Stop collaborating on "${p.name}"?`, { okText: "Leave", danger: true }))) return;
    try {
      await del(`/api/projects/${p.id}/members/${ctx.me.id}`);
      load();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  await load();
  return { destroy() {} };
}
