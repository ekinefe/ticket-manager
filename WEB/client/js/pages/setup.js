import { api } from "../api.js";
import { esc } from "../ui.js";
import { navigate } from "../main.js";
import { t } from "../i18n.js";

export async function renderSetup(root) {
  let needed = false;
  try {
    const status = await fetch("/api/setup/status", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null));
    needed = status?.needed ?? false;
  } catch {}

  if (!needed) {
    root.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card" style="text-align:center">
          <div class="brand-big" style="margin-inline:auto">TM</div>
          <h1>${t("auth.st.already")}</h1>
          <p class="sub">${t("auth.st.alreadySub")}</p>
          <a class="btn" href="/login" data-nav style="width:100%">${t("auth.signIn")}</a>
        </div>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>${t("auth.st.title")}</h1>
        <p class="sub">${t("auth.st.sub")}</p>
        <div id="setup-error" class="form-error hidden"></div>
        <form id="setup-form">
          <div class="field">
            <label for="st-email">${t("auth.email")}</label>
            <input id="st-email" type="email" autocomplete="username" required autofocus />
          </div>
          <div class="field">
            <label for="st-name">${t("auth.name")}</label>
            <input id="st-name" type="text" autocomplete="name" required />
          </div>
          <div class="field">
            <label for="st-password">${t("auth.password")} <span style="font-weight:400">${t("auth.minChars")}</span></label>
            <input id="st-password" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <div class="field">
            <label for="st-password2">${t("auth.confirmPassword")}</label>
            <input id="st-password2" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <button class="btn" type="submit" id="st-btn" style="width:100%">${t("auth.st.create")}</button>
        </form>
      </div>
    </div>`;

  const form = root.querySelector("#setup-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = root.querySelector("#setup-error");
    const btn = root.querySelector("#st-btn");
    errBox.classList.add("hidden");

    const password = form.querySelector("#st-password").value;
    if (password !== form.querySelector("#st-password2").value) {
      errBox.textContent = t("auth.passwordsMismatch");
      errBox.classList.remove("hidden");
      return;
    }

    btn.disabled = true;
    try {
      await api.post("/setup/complete", {
        email: form.querySelector("#st-email").value.trim(),
        name: form.querySelector("#st-name").value.trim(),
        password,
      });
      root.innerHTML = `
        <div class="auth-wrap">
          <div class="auth-card" style="text-align:center">
            <div class="brand-big" style="margin-inline:auto">TM</div>
            <h1>${t("auth.st.created")}</h1>
            <p class="sub">${t("auth.st.createdSub", { email: esc(form.querySelector("#st-email").value.trim()) })}</p>
            <a class="btn" href="/login" data-nav style="width:100%">${t("auth.signInNow")}</a>
          </div>
        </div>`;
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}
