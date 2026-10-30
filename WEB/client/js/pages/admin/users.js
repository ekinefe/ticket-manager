import { api } from "../../api.js";
import { loadProjects, state } from "../../main.js";
import { esc, avatarHtml, roleChip, fmtDate, openModal, toast } from "../../ui.js";
import { t as tl } from "../../i18n.js";
import { DEFAULT_MEMBER_PERMS, permsBlockHtml, wirePermsToggle } from "./perms.js";
const ROLES = ["USER", "ADMIN", "SUPER_ADMIN"];

/* ---------------- Users ---------------- */

export async function renderUsersTab(body) {
  let users;
  try {
    users = await api.get("/admin/users");
  } catch (err) {
    body.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    return;
  }

  const isSuper = state.user.role === "SUPER_ADMIN";

  body.innerHTML = users.length === 0
    ? `<div class="empty-note">${tl("adm.noUsers")}</div>`
    : `<div class="table-card">
        <table class="data">
          <thead><tr><th>${tl("adm.name")}</th><th>${tl("adm.email")}</th><th>${tl("adm.role")}</th><th>${tl("adm.created")}</th></tr></thead>
          <tbody>
            ${users.map((u) => userRow(u, isSuper)).join("")}
          </tbody>
        </table>
      </div>
      ${isSuper ? `<div class="mt-total" style="margin-top:10px">${tl("adm.clickUser")}</div>` : ""}`;

  if (!isSuper) return;

  const head = document.createElement("div");
  head.className = "page-head";
  head.style.marginBottom = "14px";
  head.innerHTML = `
    <span class="spacer" style="flex:1"></span>
    <button class="btn sm ghost" id="add-user-btn">${tl("adm.addUser")}</button>
    <button class="btn sm" id="invite-user-btn">${tl("adm.inviteUser")}</button>`;
  body.prepend(head);
  head.querySelector("#invite-user-btn").addEventListener("click", () =>
    openInviteUserModal(() => renderUsersTab(body))
  );
  head.querySelector("#add-user-btn").addEventListener("click", () =>
    openAddUserModal(() => renderUsersTab(body))
  );

  appendChangeOwnPassword(body);

  for (const tr of body.querySelectorAll("tr[data-user-id]")) {
    tr.addEventListener("click", () => {
      const u = users.find((x) => x.id === tr.getAttribute("data-user-id"));
      if (u) openUserModal(u, () => renderUsersTab(body));
    });
  }
}

/* ---------------- Change my own password ---------------- */

function appendChangeOwnPassword(body) {
  const wrap = document.createElement("div");
  wrap.className = "table-card";
  wrap.style.marginTop = "16px";
  wrap.style.padding = "18px 20px";
  wrap.innerHTML = `
    <div style="font-weight:700;margin-bottom:14px">${tl("adm.cpTitle")}</div>
    <form id="change-pw-form" style="max-width:420px">
      <div class="field">
        <label for="cp-current">${tl("adm.cpCurrent")}</label>
        <input type="password" id="cp-current" autocomplete="current-password" required />
      </div>
      <div class="field">
        <label for="cp-new">${tl("adm.cpNew")} ${tl("adm.minChars")}</label>
        <input type="password" id="cp-new" autocomplete="new-password" required />
      </div>
      <div class="modal-actions" style="margin-top:16px">
        <span id="cp-msg" style="font-size:13px;color:var(--text-dim)"></span>
        <span class="right">
          <button class="btn" type="submit" id="cp-btn">${tl("adm.cpUpdate")}</button>
        </span>
      </div>
    </form>`;
  body.appendChild(wrap);

  wrap.querySelector("#change-pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = wrap.querySelector("#cp-btn");
    const msg = wrap.querySelector("#cp-msg");
    btn.disabled = true;
    msg.textContent = "";
    try {
      await api.changePassword(
        wrap.querySelector("#cp-current").value,
        wrap.querySelector("#cp-new").value
      );
      msg.textContent = tl("adm.cpDone");
      msg.style.color = "var(--ok)";
      wrap.querySelector("#cp-current").value = "";
      wrap.querySelector("#cp-new").value = "";
      toast(tl("adm.cpToast"), "ok");
    } catch (err) {
      msg.textContent = err.message;
      msg.style.color = "var(--danger)";
    } finally {
      btn.disabled = false;
    }
  });
}

function confirmDeleteUser(u, reload, closeEditor) {
  openModal({
    title: tl("adm.duTitle"),
    body: `
      <p>${tl("adm.duBody", { name: `<strong>${esc(u.name)}</strong>`, email: esc(u.email) })}</p>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="du-cancel">${tl("adm.cancel")}</button>
          <button class="btn danger" id="du-confirm">${tl("adm.delete")}</button>
        </span>
      </div>`,
    onMount(modalEl, closeConfirm) {
      modalEl.querySelector("#du-cancel").addEventListener("click", closeConfirm);
      modalEl.querySelector("#du-confirm").addEventListener("click", async () => {
        try {
          await api.del(`/admin/users/${u.id}`);
          toast(tl("adm.duToast", { email: u.email }), "ok");
          closeConfirm();
          closeEditor();
          reload();
        } catch (err) {
          toast(err.message, "err");
        }
      });
    },
  });
}

/* ---------------- Add user (no invite e-mail) ---------------- */

function openAddUserModal(reload) {
  openModal({
    title: tl("adm.auTitle"),
    body: `
      <div class="field">
        <label for="au-name">${tl("adm.name")}</label>
        <input type="text" id="au-name" autocomplete="off" />
      </div>
      <div class="field">
        <label for="au-email">${tl("adm.email")}</label>
        <input type="email" id="au-email" placeholder="name@company.com" autocomplete="off" />
      </div>
      <div class="field">
        <label for="au-password">${tl("adm.auPassword")} ${tl("adm.minChars")}</label>
        <input type="password" id="au-password" autocomplete="new-password" />
      </div>
      <div class="field">
        <label for="au-role">${tl("adm.role")}</label>
        <select id="au-role">
          ${ROLES.map((r) => `<option value="${r}">${tl(`role.${r}`)}</option>`).join("")}
        </select>
        <div style="color:var(--text-dim);font-size:12px;margin-top:6px">
          ${tl("adm.auCreateNote")}
        </div>
      </div>
      <div class="form-error hidden" id="au-error"></div>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="au-cancel">${tl("adm.cancel")}</button>
          <button class="btn" id="au-create">${tl("adm.auCreate")}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      const body = modalEl.querySelector(".modal-body") || modalEl;
      const errBox = body.querySelector("#au-error");
      const create = async () => {
        errBox.classList.add("hidden");
        const payload = {
          name: body.querySelector("#au-name").value.trim(),
          email: body.querySelector("#au-email").value.trim(),
          password: body.querySelector("#au-password").value,
          role: body.querySelector("#au-role").value,
        };
        try {
          await api.post("/admin/users", payload);
          toast(tl("adm.auCreated", { email: payload.email }), "ok");
          reload();
          showCreatedUserMessage(modalEl, close, payload);
        } catch (err) {
          errBox.textContent = err.message;
          errBox.classList.remove("hidden");
        }
      };
      body.querySelector("#au-cancel").addEventListener("click", close);
      body.querySelector("#au-create").addEventListener("click", create);
      body.querySelectorAll("input").forEach((el) =>
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); create(); }
        })
      );
    },
  });
}

function showCreatedUserMessage(modalEl, close, { name, email, password }) {
  const body = modalEl.querySelector(".modal-body") || modalEl;
  const loginUrl = `${location.origin}/login`;
  const message = tl("adm.cmMessage", { url: loginUrl, email, password });
  body.innerHTML = `
    <p style="margin-top:0">${tl("adm.cmReady", { name: esc(name) })}</p>
    <textarea id="au-message" readonly rows="7" style="width:100%;resize:vertical;font-size:12px;font-family:inherit">${esc(message)}</textarea>
    <div class="modal-actions">
      <span></span>
      <span class="right">
        <button class="btn ghost" id="au-copy">${tl("adm.copy")}</button>
        <button class="btn" id="au-done">${tl("adm.done")}</button>
      </span>
    </div>`;
  body.querySelector("#au-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast(tl("adm.copied"), "ok");
    } catch {
      body.querySelector("#au-message").select();
    }
  });
  body.querySelector("#au-done").addEventListener("click", close);
}

/* ---------------- Invite user ---------------- */

function openInviteUserModal(reload) {
  openModal({
    title: tl("adm.ivTitle"),
    body: `
      <div class="field">
        <label for="iu-email">${tl("adm.email")}</label>
        <input type="email" id="iu-email" placeholder="name@company.com" autocomplete="off" />
        <div style="color:var(--text-dim);font-size:12px;margin-top:6px">
          ${tl("adm.ivNote")}
        </div>
      </div>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="iu-cancel">${tl("adm.cancel")}</button>
          <button class="btn" id="iu-send">${tl("adm.ivSend")}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      const body = modalEl.querySelector(".modal-body") || modalEl;
      const send = async () => {
        const email = body.querySelector("#iu-email").value.trim();
        try {
          const res = await api.post("/admin/invites", { email });
          toast(tl("adm.ivSent", { email }), "ok");
          reload();
          showInviteLink(modalEl, close, res.inviteUrl);
        } catch (err) {
          toast(err.message, "err");
        }
      };
      body.querySelector("#iu-cancel").addEventListener("click", close);
      body.querySelector("#iu-send").addEventListener("click", send);
      body.querySelector("#iu-email").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); send(); }
      });
    },
  });
}

function showInviteLink(modalEl, close, url) {
  const body = modalEl.querySelector(".modal-body") || modalEl;
  body.innerHTML = `
    <p style="margin-top:0">${tl("adm.ivLinkNote")}</p>
    <div style="display:flex;gap:8px">
      <input type="text" id="iu-link" value="${esc(url)}" readonly style="font-size:12px" />
      <button class="btn sm ghost" id="iu-copy">${tl("adm.copy")}</button>
    </div>
    <div class="modal-actions">
      <span></span>
      <span class="right"><button class="btn" id="iu-done">${tl("adm.done")}</button></span>
    </div>`;
  body.querySelector("#iu-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast(tl("adm.linkCopied"), "ok");
    } catch {
      body.querySelector("#iu-link").select();
    }
  });
  body.querySelector("#iu-done").addEventListener("click", close);
}

function userRow(u, isSuper) {
  const isSelf = u.id === state.user.id;
  const roleCell = `${roleChip(u.role)}${isSelf ? ` <span style="color:var(--text-dim);font-size:12px">${tl("adm.you")}</span>` : ""}`;
  return `
    <tr data-user-id="${esc(u.id)}" class="${isSuper ? "clickable" : ""}">
      <td style="display:flex;align-items:center;gap:10px">${avatarHtml(u.name, u.id)} ${esc(u.name)}</td>
      <td>${esc(u.email)}</td>
      <td>${roleCell}</td>
      <td style="color:var(--text-dim)">${fmtDate(u.createdAt)}</td>
    </tr>`;
}

/* ---------------- User detail / edit modal ---------------- */

export const MEMBER_ROLES = ["MEMBER", "ADMIN"];

async function openUserModal(u, reload) {
  let detail, projects;
  try {
    [detail, projects] = await Promise.all([
      api.get(`/admin/users/${u.id}`),
      loadProjects(true),
    ]);
  } catch (err) {
    toast(err.message, "err");
    return;
  }

  const isSelf = detail.id === state.user.id;
  const memberships = new Map(detail.projects.map((p) => [p.projectId, p.role]));

  openModal({
    title: tl("adm.umTitle"),
    wide: true,
    body: `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
        ${avatarHtml(detail.name, detail.id)}
        <div>
          <div style="font-weight:700">${esc(detail.name)}</div>
          <div style="color:var(--text-dim);font-size:13px">${esc(detail.email)}</div>
        </div>
        <span style="margin-left:auto">${roleChip(detail.role)}</span>
      </div>

      <div class="field">
        <label for="um-role">${tl("adm.umGlobalRole")}</label>
        ${isSelf
          ? `<div style="font-size:13px;padding:2px 0">${roleChip(detail.role)} <span style="color:var(--text-dim);font-size:12.5px">${tl("adm.umSelfRole")}</span></div>`
          : `<select id="um-role">
              ${ROLES.map((r) => `<option value="${r}"${r === detail.role ? " selected" : ""}>${tl(`role.${r}`)}</option>`).join("")}
            </select>`}
      </div>

      <div class="field" style="margin-bottom:6px">
        <label>${tl("adm.umProjectAccess")}</label>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px">${tl("adm.umProjectHint")}</div>
      </div>
      <div id="um-projects">
        ${projects.map((p) => {
          const membership = detail.projects.find((m) => m.projectId === p.id);
          const memberRole = membership?.role;
          const granted = membership ? (membership.permissions || []) : DEFAULT_MEMBER_PERMS;
          return `
          <div class="up-block" style="border-bottom:1px solid var(--border)">
          <div class="up-row" data-project="${esc(p.id)}" style="display:flex;align-items:center;gap:10px;padding:7px 4px">
            <input type="checkbox" id="up-${esc(p.id)}" ${memberRole ? "checked" : ""} />
            <label for="up-${esc(p.id)}" style="flex:1;display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;font-weight:400;color:var(--text);font-size:13.5px">
              <span class="prefix-chip">${esc(p.prefix)}</span> ${esc(p.name)}
            </label>
            <select class="up-role" ${memberRole ? "" : "disabled"} style="max-width:120px">
              ${MEMBER_ROLES.map((r) => `<option value="${r}"${(memberRole || "MEMBER") === r ? " selected" : ""}>${tl(`role.${r}`)}</option>`).join("")}
            </select>
          </div>
          ${permsBlockHtml(p.id, detail.availablePermissions, granted)}
          </div>`;
        }).join("")}
        ${projects.length === 0 ? `<div class="empty-note">${tl("adm.noProjects")}</div>` : ""}
      </div>

      <div class="modal-actions">
        ${state.user.role === "SUPER_ADMIN" && !isSelf
          ? `<span style="display:flex;gap:8px">
              <button class="btn ghost" id="um-password">${tl("adm.setPassword")}</button>
              <button class="btn danger" id="um-delete">${tl("adm.deleteUser")}</button>
            </span>`
          : "<span></span>"}
        <span class="right">
          <button class="btn ghost" id="um-cancel">${tl("adm.cancel")}</button>
          <button class="btn" id="um-save">${tl("adm.save")}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      const setPwBtn = modalEl.querySelector("#um-password");
      if (setPwBtn) setPwBtn.addEventListener("click", () => openSetPasswordModal(detail, reload, close));
      const delBtn = modalEl.querySelector("#um-delete");
      if (delBtn) delBtn.addEventListener("click", () => confirmDeleteUser(detail, reload, close));
      // enable/disable the project role select with the checkbox, and keep
      // each project's permission checkboxes in sync with it
      for (const row of modalEl.querySelectorAll(".up-row")) {
        const cb = row.querySelector("input[type=checkbox]");
        const sel = row.querySelector(".up-role");
        cb.addEventListener("change", () => { sel.disabled = !cb.checked; });
        const projectId = row.dataset.project;
        const membership = detail.projects.find((m) => m.projectId === projectId);
        const permsBlock = modalEl.querySelector(`.up-perms[data-scope="${CSS.escape(projectId)}"]`);
        wirePermsToggle(row, permsBlock, membership ? (membership.permissions || []) : DEFAULT_MEMBER_PERMS);
      }

      modalEl.querySelector("#um-cancel").addEventListener("click", close);

      modalEl.querySelector("#um-save").addEventListener("click", async () => {
        const saveBtn = modalEl.querySelector("#um-save");
        saveBtn.disabled = true;
        try {
          // global role
          const roleSel = modalEl.querySelector("#um-role");
          if (roleSel && roleSel.value !== detail.role) {
            await api.patch(`/admin/users/${detail.id}`, { role: roleSel.value });
          }
          // project memberships: upsert checked, remove unchecked
          for (const row of modalEl.querySelectorAll(".up-row")) {
            const projectId = row.dataset.project;
            const checked = row.querySelector("input[type=checkbox]").checked;
            const role = row.querySelector(".up-role").value;
            const original = memberships.get(projectId);
            if (checked && original !== role) {
              await api.post(`/admin/users/${detail.id}/projects`, { projectId, role });
            } else if (!checked && original !== undefined) {
              await api.del(`/admin/users/${detail.id}/projects/${projectId}`);
            }
            if (checked && role === "MEMBER") {
              const permsBlock = modalEl.querySelector(`.up-perms[data-scope="${CSS.escape(projectId)}"]`);
              const selected = [...permsBlock.querySelectorAll(".perm-cb:checked")].map((cb2) => cb2.value);
              await api.patch(`/admin/users/${detail.id}/projects/${projectId}/permissions`, { permissions: selected });
            }
          }
          toast(tl("adm.umSaved", { name: detail.name }), "ok");
          close();
          reload();
        } catch (err) {
          saveBtn.disabled = false;
          toast(err.message, "err");
        }
      });
    },
  });
}

/* ---------------- Set a user's password (super admin) ---------------- */

function openSetPasswordModal(u, reload) {
  openModal({
    title: tl("adm.spTitle", { name: u.name }),
    body: `
      <div class="field">
        <label for="sp-password">${tl("adm.spNew")} ${tl("adm.minChars")}</label>
        <input type="password" id="sp-password" autocomplete="new-password" required />
        <div style="color:var(--text-dim);font-size:12px;margin-top:6px">
          ${tl("adm.spNote")}
        </div>
      </div>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="sp-cancel">${tl("adm.cancel")}</button>
          <button class="btn" id="sp-save">${tl("adm.setPassword")}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      modalEl.querySelector("#sp-cancel").addEventListener("click", close);
      modalEl.querySelector("#sp-save").addEventListener("click", async () => {
        const btn = modalEl.querySelector("#sp-save");
        btn.disabled = true;
        try {
          const password = modalEl.querySelector("#sp-password").value;
          await api.adminSetPassword(u.id, password);
          toast(tl("adm.spDone", { name: u.name }), "ok");
          close();
          reload();
        } catch (err) {
          btn.disabled = false;
          toast(err.message, "err");
        }
      });
    },
  });
}
