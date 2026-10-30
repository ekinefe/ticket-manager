import { api } from "../api.js";
import { state, navigate } from "../main.js";
import { esc, roleChip, toast } from "../ui.js";
import { t } from "../i18n.js";

// Personal settings for every signed-in user (not part of the admin panel).
export async function renderSettings(root) {
  const u = state.user;
  root.innerHTML = `
    <div class="page settings-page">
      <div class="page-head"><h1>${t("set.title")}</h1></div>

      <section class="settings-card">
        <h2>${t("set.profile")}</h2>
        <p class="hint">${t("set.profileHint")}</p>
        <form id="set-profile">
          <div class="field">
            <label for="set-name">${t("set.name")}</label>
            <input id="set-name" type="text" maxlength="80" value="${esc(u.name)}" required />
          </div>
          <div class="field">
            <label for="set-email">${t("set.email")}</label>
            <input id="set-email" type="email" value="${esc(u.email || "")}" readonly />
            <span class="field-hint">${t("set.emailHint")}</span>
          </div>
          <div class="field">
            <label>${t("set.role")}</label>
            ${roleChip(u.role)}
          </div>
          <div class="settings-actions"><button class="btn" type="submit">${t("set.saveProfile")}</button></div>
        </form>
      </section>

      <section class="settings-card">
        <h2>${t("set.security")}</h2>
        <p class="hint">${t("set.securityHint")}</p>
        <div id="set-pw-error" class="form-error hidden"></div>
        <form id="set-password">
          <div class="field">
            <label for="set-current">${t("set.currentPassword")}</label>
            <input id="set-current" type="password" autocomplete="current-password" required />
          </div>
          <div class="field">
            <label for="set-new">${t("set.newPassword")}</label>
            <input id="set-new" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <div class="field">
            <label for="set-new2">${t("auth.confirmPassword")}</label>
            <input id="set-new2" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <div class="settings-actions"><button class="btn" type="submit">${t("set.changePassword")}</button></div>
        </form>
      </section>
    </div>`;

  root.querySelector("#set-profile").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = root.querySelector("#set-name").value.trim();
    if (!name) { toast(t("set.nameRequired"), "err"); return; }
    try {
      const r = await api.patch("/me", { name });
      state.user.name = r.name;
      toast(t("set.profileSaved"));
      navigate("/settings"); // re-render so the header shows the new name
    } catch (err) {
      toast(err.message, "err");
    }
  });

  const pwForm = root.querySelector("#set-password");
  const pwError = root.querySelector("#set-pw-error");
  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    pwError.classList.add("hidden");
    const next = pwForm.querySelector("#set-new").value;
    if (next !== pwForm.querySelector("#set-new2").value) {
      pwError.textContent = t("auth.passwordsMismatch");
      pwError.classList.remove("hidden");
      return;
    }
    try {
      await api.changePassword(pwForm.querySelector("#set-current").value, next);
      pwForm.reset();
      toast(t("set.passwordChanged"));
    } catch (err) {
      pwError.textContent = err.message;
      pwError.classList.remove("hidden");
    }
  });
}
