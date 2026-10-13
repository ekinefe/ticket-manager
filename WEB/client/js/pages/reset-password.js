import { api } from "../api.js";
import { esc } from "../ui.js";
import { t } from "../i18n.js";

export async function renderResetPassword(root) {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";

  if (token) return renderNewPasswordForm(root, token);
  return renderRequestForm(root);
}

function renderRequestForm(root) {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>${t("auth.rp.forgot")}</h1>
        <p class="sub">${t("auth.rp.forgotSub")}</p>
        <div id="rp-error" class="form-error hidden"></div>
        <form id="rp-form">
          <div class="field">
            <label for="rp-email">${t("auth.email")}</label>
            <input id="rp-email" type="email" autocomplete="username" required autofocus />
          </div>
          <button class="btn" type="submit" style="width:100%" id="rp-btn">${t("auth.rp.send")}</button>
        </form>
        <p style="text-align:center;margin:14px 0 0"><a href="/login" data-nav>${t("auth.backToSignIn")}</a></p>
      </div>
    </div>`;

  const form = root.querySelector("#rp-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = root.querySelector("#rp-btn");
    btn.disabled = true;
    try {
      // The API always answers ok, regardless of account existence.
      await api.post("/auth/request-password-reset", { email: form.querySelector("#rp-email").value.trim() });
      root.querySelector(".auth-card").innerHTML = `
        <div class="brand-big">TM</div>
        <h1>${t("auth.rp.inbox")}</h1>
        <p class="sub">${t("auth.rp.inboxSub")}</p>
        <a class="btn" href="/login" data-nav style="width:100%">${t("auth.backToSignIn")}</a>`;
    } catch (err) {
      const errBox = root.querySelector("#rp-error");
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}

function renderNewPasswordForm(root, token) {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>${t("auth.rp.choose")}</h1>
        <div id="rp-error" class="form-error hidden"></div>
        <form id="rp-form">
          <div class="field">
            <label for="rp-password">${t("auth.rp.new")} <span style="font-weight:400">${t("auth.minChars")}</span></label>
            <input id="rp-password" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <div class="field">
            <label for="rp-password2">${t("auth.confirmPassword")}</label>
            <input id="rp-password2" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <button class="btn" type="submit" style="width:100%" id="rp-btn">${t("auth.setPassword")}</button>
        </form>
      </div>
    </div>`;

  const form = root.querySelector("#rp-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = root.querySelector("#rp-error");
    const btn = root.querySelector("#rp-btn");
    const password = form.querySelector("#rp-password").value;
    if (password !== form.querySelector("#rp-password2").value) {
      errBox.textContent = t("auth.passwordsMismatch");
      errBox.classList.remove("hidden");
      return;
    }
    btn.disabled = true;
    try {
      await api.post("/auth/reset-password", { token, password });
      root.querySelector(".auth-card").innerHTML = `
        <div class="brand-big">TM</div>
        <h1>${t("auth.rp.updated")}</h1>
        <p class="sub">${t("auth.rp.updatedSub")}</p>
        <a class="btn" href="/login" data-nav style="width:100%">${t("auth.signIn")}</a>`;
    } catch (err) {
      errBox.textContent = esc(err.message);
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}
