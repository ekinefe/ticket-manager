import { api } from "../api.js";
import { esc } from "../ui.js";
import { navigate } from "../main.js";
import { t } from "../i18n.js";

export async function renderAcceptInvite(root) {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";

  if (!token) {
    return renderResult(root, t("auth.iv.invalid"), t("auth.iv.noToken"), false);
  }

  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>${t("auth.iv.title")}</h1>
        <p class="sub">${t("auth.iv.sub")}</p>
        <div id="invite-error" class="form-error hidden"></div>
        <form id="invite-form">
          <div class="field">
            <label for="iv-name">${t("auth.iv.name")}</label>
            <input id="iv-name" type="text" autocomplete="name" required />
          </div>
          <div class="field">
            <label for="iv-password">${t("auth.password")} <span style="font-weight:400">${t("auth.minChars")}</span></label>
            <input id="iv-password" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <div class="field">
            <label for="iv-password2">${t("auth.confirmPassword")}</label>
            <input id="iv-password2" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <button class="btn" type="submit" id="iv-btn" style="width:100%">${t("auth.iv.accept")}</button>
        </form>
      </div>
    </div>`;

  const form = root.querySelector("#invite-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = root.querySelector("#invite-error");
    const btn = root.querySelector("#iv-btn");
    errBox.classList.add("hidden");

    const password = form.querySelector("#iv-password").value;
    if (password !== form.querySelector("#iv-password2").value) {
      errBox.textContent = t("auth.passwordsMismatch");
      errBox.classList.remove("hidden");
      return;
    }

    btn.disabled = true;
    try {
      await api.post("/invitations/accept", {
        token,
        name: form.querySelector("#iv-name").value.trim(),
        password,
      });
      renderSuccess(root);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}

function renderSuccess(root) {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card" style="text-align:center">
        <div class="brand-big" style="margin-inline:auto">TM</div>
        <h1>${t("auth.iv.in")}</h1>
        <p class="sub">${t("auth.iv.inSub")}</p>
        <a class="btn" href="/login" data-nav style="width:100%">${t("auth.signInNow")}</a>
      </div>
    </div>`;
}

function renderResult(root, title, message, showLoginLink = true) {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card" style="text-align:center">
        <div class="brand-big" style="margin-inline:auto${showLoginLink ? ";background:#b3261e" : ""}">${showLoginLink ? "!" : "TM"}</div>
        <h1>${esc(title)}</h1>
        <p class="sub">${esc(message)}</p>
        ${showLoginLink ? `<a class="btn ghost" href="/" data-nav>${t("auth.iv.home")}</a>` : ""}
      </div>
    </div>`;
}
