import { api } from "../api.js";
import { navigate, state } from "../main.js";
import { t, langSwitcherHtml, bindLangSwitcher } from "../i18n.js";

export async function renderLogin(root) {
  const params = new URLSearchParams(location.search);
  const next = params.get("next") || "/welcome";

  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-lang">${langSwitcherHtml()}</div>
        <div class="brand-big">TM</div>
        <h1>${t("login.title")}</h1>
        <p class="sub">${t("login.sub")}</p>
        <div id="login-error" class="form-error hidden"></div>
        <form id="login-form">
          <div class="field">
            <label for="email">${t("login.email")}</label>
            <input id="email" name="email" type="email" autocomplete="username" required autofocus />
          </div>
          <div class="field">
            <label for="password">${t("login.password")}</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
          </div>
          <button class="btn" type="submit" style="width:100%" id="login-btn">${t("common.signIn")}</button>
        </form>
        <p style="text-align:center;margin:12px 0 0"><a href="/reset-password" data-nav>${t("login.forgot")}</a></p>
      </div>
    </div>`;

  bindLangSwitcher(root);
  const form = root.querySelector("#login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = root.querySelector("#login-btn");
    const errBox = root.querySelector("#login-error");
    errBox.classList.add("hidden");
    btn.disabled = true;
    try {
      await api.signIn(form.email.value.trim(), form.password.value);
      const session = await api.session();
      state.user = session?.user ?? null;
      navigate(next.startsWith("/") ? next : "/welcome");
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}
