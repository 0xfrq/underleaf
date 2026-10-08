import { get, post } from "./api.js";
import { renderLogin } from "./login.js";
import { renderDashboard } from "./dashboard.js";
import { openEditor } from "./editor.js";
import { openTasks, matchTasksPath } from "./tasks.js";
import { renderMyWork } from "./mywork.js";
import { h } from "./ui.js";

const root = document.getElementById("app");
let me = undefined; // undefined = unknown, null = logged out
let config = null;
let current = null;
let seq = 0;

const ctx = {
  get me() {
    return me;
  },
  setMe(u) {
    me = u;
  },
  navigate,
  async logout() {
    try {
      await post("/api/auth/logout");
    } catch {
      /* ignore */
    }
    me = null;
    navigate("/");
  },
};

function navigate(path, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else if (path !== location.pathname) history.pushState(null, "", path);
  route();
}

async function route() {
  // A page may handle the new URL itself (e.g. switching views of one task board).
  if (current && current.reroute && me && current.reroute(location.pathname)) return;
  const token = ++seq;
  if (current && current.destroy) {
    try {
      current.destroy();
    } catch (e) {
      console.error(e);
    }
  }
  current = null;
  document.title = "Underleaf";

  if (!config) config = await get("/api/config").catch(() => ({ allow_signup: false }));
  if (me === undefined) me = await get("/api/auth/me").catch(() => null);
  if (token !== seq) return;

  root.replaceChildren();
  if (!me) {
    current = renderLogin(root, config, (user) => {
      me = user;
      navigate(location.pathname, true);
    });
    return;
  }

  const m = location.pathname.match(/^\/project\/([0-9a-f]+)\/?$/);
  const tasks = matchTasksPath(location.pathname);
  try {
    let page;
    if (m) {
      page = await openEditor(root, m[1], ctx);
    } else if (tasks) {
      page = await openTasks(root, tasks[0], tasks[1], ctx);
    } else if (/^\/tasks\/?$/.test(location.pathname)) {
      page = await renderMyWork(root, ctx);
    } else {
      if (location.pathname !== "/") history.replaceState(null, "", "/");
      page = await renderDashboard(root, ctx);
    }
    if (token !== seq) {
      if (page && page.destroy) page.destroy();
      return;
    }
    current = page;
  } catch (e) {
    if (token !== seq) return;
    root.replaceChildren(
      h("div", { class: "auth-page" },
        h("div", { class: "auth-card" },
          h("h3", null, e.status === 404 ? "Project not found" : "Something went wrong"),
          h("p", { class: "muted" }, e.status === 404 ? "It may have been deleted, or you no longer have access." : e.message),
          h("a", { href: "/", "data-link": "" }, "← Back to projects"))));
  }
}

window.addEventListener("popstate", route);
window.addEventListener("ul:unauthorized", () => {
  if (me) {
    me = null;
    route();
  }
});
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[data-link]");
  if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    navigate(a.getAttribute("href"));
  }
});

route();
