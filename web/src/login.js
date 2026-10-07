import { post } from "./api.js";
import { h, logo } from "./ui.js";

export function renderLogin(root, config, onLogin) {
  let mode = "login";
  const err = h("div", { class: "form-error" });
  const username = h("input", { type: "text", autocomplete: "username", placeholder: "Username", required: true });
  const display = h("input", { type: "text", autocomplete: "name", placeholder: "Display name (optional)" });
  const password = h("input", { type: "password", autocomplete: "current-password", placeholder: "Password", required: true });
  const submit = h("button", { class: "btn primary block", type: "submit" }, "Log in");
  const displayRow = h("div", { class: "hidden" }, display);
  const toggle = config.allow_signup
    ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); setMode(mode === "login" ? "register" : "login"); } })
    : null;

  const form = h(
    "form",
    {
      class: "auth-form",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        submit.disabled = true;
        try {
          const body = { username: username.value.trim(), password: password.value };
          if (mode === "register" && display.value.trim()) body.display_name = display.value.trim();
          const user = await post(mode === "login" ? "/api/auth/login" : "/api/auth/register", body);
          onLogin(user);
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    username,
    displayRow,
    password,
    submit,
    err,
    toggle ? h("div", { class: "auth-switch" }, toggle) : null,
  );

  function setMode(m) {
    mode = m;
    submit.textContent = m === "login" ? "Log in" : "Create account";
    displayRow.classList.toggle("hidden", m === "login");
    password.setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
    password.placeholder = m === "login" ? "Password" : "Password (min. 8 characters)";
    if (toggle) toggle.textContent = m === "login" ? "No account yet? Create one" : "Already have an account? Log in";
    err.textContent = "";
  }
  setMode("login");

  root.append(
    h("div", { class: "auth-page" },
      h("div", { class: "auth-card" },
        h("div", { class: "brand big" }, logo(), "Underleaf"),
        h("p", { class: "muted small", style: { textAlign: "center", margin: "6px 0 0" } }, "Collaborative LaTeX, self-hosted."),
        form)),
  );
  setTimeout(() => username.focus(), 0);
  return { destroy() {} };
}
