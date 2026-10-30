import { api } from "../../api.js";
import { state } from "../../main.js";
import { esc, toast, STATUSES, STATUS_LABELS } from "../../ui.js";
import { t as tl } from "../../i18n.js";

/* ---------------- Settings ---------------- */

export async function renderSettingsTab(body) {
  if (state.user.role !== "SUPER_ADMIN") {
    body.innerHTML = `<div class="empty-note">${tl("adm.sOnlySuper")}</div>`;
    return;
  }

  let settings;
  try {
    settings = await api.get("/admin/settings");
  } catch (err) {
    body.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    return;
  }

  // Unset = built-in default; "" = none.
  const notifySet = new Set(
    settings.mail_notify_statuses === undefined
      ? ["UNDER_REVIEW", "DEPLOYED", "TEST"]
      : settings.mail_notify_statuses.split(",").filter(Boolean)
  );

  body.innerHTML = `
    <div class="page-head">
      <span class="spacer" style="flex:1"></span>
    </div>
    <form id="settings-form" class="settings-form">
      <div class="settings-section">
        <h3 class="settings-heading">${tl("adm.sApp")}</h3>
        <div class="field">
          <label for="s-app-url">${tl("adm.sAppUrl")}</label>
          <input type="url" id="s-app-url" value="${esc(settings.app_url || "")}" placeholder="https://tickets.example.com" />
          <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("adm.sAppUrlNote")}</div>
        </div>
        <div class="field">
          <label for="s-auth-secret">${tl("adm.sSecret")}</label>
          <input type="password" id="s-auth-secret" value="${esc(settings.better_auth_secret || "")}" placeholder="${tl("adm.sSecretPh")}" autocomplete="off" />
          <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("adm.sSecretNote", { env: "<code>BETTER_AUTH_SECRET</code>" })}</div>
        </div>
      </div>

      <div class="settings-section">
        <h3 class="settings-heading">${tl("adm.sMail")}</h3>
        <div class="field">
          <label for="s-mail-transport">${tl("adm.sTransport")}</label>
          <select id="s-mail-transport">
            <option value="file" ${(settings.mail_transport || "file") === "file" ? "selected" : ""}>${tl("adm.sFile")}</option>
            <option value="resend" ${settings.mail_transport === "resend" ? "selected" : ""}>Resend</option>
          </select>
          <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("adm.sTransportNote", { file: "<b>File</b>", dir: "<code>.mail-out/</code>", resend: "<b>Resend</b>" })}</div>
        </div>
        <div class="field">
          <label for="s-resend-key">${tl("adm.sResendKey")}</label>
          <input type="password" id="s-resend-key" value="${esc(settings.resend_api_key || "")}" placeholder="re_..." autocomplete="off" />
          <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("adm.sResendNote", { link: '<a href="https://resend.com/api-keys" target="_blank" rel="noopener">resend.com/api-keys</a>' })}</div>
        </div>
        <div class="field">
          <label for="s-mail-from">${tl("adm.sFrom")}</label>
          <input type="email" id="s-mail-from" value="${esc(settings.mail_from || "")}" placeholder="Ticket Manager &lt;no-reply@tickets.local&gt;" />
          <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("adm.sFromNote")}</div>
        </div>
        <div class="field">
          <label>${tl("adm.sNotifyWhen")}</label>
          <div id="s-notify-statuses" style="display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:4px">
            ${STATUSES.map((s) => `<label><input type="checkbox" value="${s}" ${notifySet.has(s) ? "checked" : ""} /> ${esc(STATUS_LABELS[s])}</label>`).join("")}
          </div>
          <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("adm.sNotifyNote")}</div>
        </div>
      </div>

      <div class="settings-section">
        <h3 class="settings-heading">${tl("adm.sGithub")}</h3>
        <div style="color:var(--text-dim);font-size:12.5px;margin-bottom:10px">
          ${tl("adm.sGhIntro", { url: `<code id="gh-webhook-url">${esc(location.origin)}/api/github/webhook</code>` })}
        </div>
        <div class="field">
          <label for="s-gh-app-id">${tl("adm.sGhAppId")}</label>
          <input type="text" id="s-gh-app-id" value="${esc(settings.github_app_id || "")}" autocomplete="off" />
        </div>
        <div class="field">
          <label for="s-gh-key">${tl("adm.sGhKey")}</label>
          <textarea id="s-gh-key" rows="4" spellcheck="false" autocomplete="off" placeholder="-----BEGIN PRIVATE KEY-----">${esc(settings.github_private_key || "")}</textarea>
          <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("adm.sGhKeyNote", { cmd: "<code>openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem</code>" })}</div>
        </div>
        <div class="field">
          <label for="s-gh-secret">${tl("adm.sGhSecret")}</label>
          <input type="password" id="s-gh-secret" value="${esc(settings.github_webhook_secret || "")}" autocomplete="off" />
        </div>
        <div class="field">
          <label><input type="checkbox" id="s-gh-branch" ${settings.github_branch_create === "1" ? "checked" : ""} /> ${tl("adm.sGhBranch")}</label>
          <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("adm.sGhBranchNote")}</div>
        </div>
      </div>

      <div class="modal-actions">
        <span id="settings-msg" style="font-size:13px;color:var(--text-dim)"></span>
        <span class="right">
          <button type="submit" class="btn" id="s-save">${tl("adm.sSave")}</button>
        </span>
      </div>
    </form>`;

  body.querySelector("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = body.querySelector("#s-save");
    const msg = body.querySelector("#settings-msg");
    saveBtn.disabled = true;
    msg.textContent = "";
    try {
      await api.patch("/admin/settings", {
        app_url: body.querySelector("#s-app-url").value.trim(),
        better_auth_secret: body.querySelector("#s-auth-secret").value,
        mail_transport: body.querySelector("#s-mail-transport").value,
        resend_api_key: body.querySelector("#s-resend-key").value,
        mail_from: body.querySelector("#s-mail-from").value.trim(),
        mail_notify_statuses: [...body.querySelectorAll("#s-notify-statuses input:checked")].map((i) => i.value).join(","),
        github_app_id: body.querySelector("#s-gh-app-id").value.trim(),
        github_private_key: body.querySelector("#s-gh-key").value,
        github_webhook_secret: body.querySelector("#s-gh-secret").value,
        github_branch_create: body.querySelector("#s-gh-branch").checked ? "1" : "0",
      });
      msg.textContent = tl("adm.sSaved");
      msg.style.color = "var(--ok)";
      toast(tl("adm.sSavedToast"), "ok");
    } catch (err) {
      msg.textContent = err.message;
      msg.style.color = "var(--danger)";
    } finally {
      saveBtn.disabled = false;
    }
  });
}
