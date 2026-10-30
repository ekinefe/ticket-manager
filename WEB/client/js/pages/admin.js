import { api } from "../api.js";
import { loadProjects, state } from "../main.js";
import { esc, avatarHtml, roleChip, fmtDate, openModal, toast, STATUSES, STATUS_LABELS } from "../ui.js";
import { t as tl, labels } from "../i18n.js";
const ROLES = ["USER", "ADMIN", "SUPER_ADMIN"];
const permLabels = labels;

export async function renderAdmin(root, section = "users") {
  if (!requireAdminAccess(root)) return;

  root.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>${tl("adm.title")}</h1></div>
      <nav class="tabs">
        <a class="tab${section === "users" ? " active" : ""}" href="/admin/users" data-nav>${tl("adm.tabUsers")}</a>
        <a class="tab${section === "projects" ? " active" : ""}" href="/admin/projects" data-nav>${tl("adm.tabProjects")}</a>
        ${state.user.role === "SUPER_ADMIN" ? `<a class="tab${section === "access" ? " active" : ""}" href="/admin/access" data-nav>${tl("adm.tabAccess")}</a>` : ""}
        <a class="tab${section === "settings" ? " active" : ""}" href="/admin/settings" data-nav>${tl("adm.tabSettings")}</a>
      </nav>
      <div id="admin-body"><div class="spinner"></div></div>
    </div>`;

  const body = root.querySelector("#admin-body");
  if (section === "projects") await renderProjectsTab(body);
  else if (section === "settings") await renderSettingsTab(body);
  else if (section === "access") await renderAccessTab(body);
  else await renderUsersTab(body);
}

function requireAdminAccess(root) {
  if (state.user.role === "USER") {
    root.innerHTML = `
      <div class="page">
        <h1>${tl("adm.title")}</h1>
        <div class="empty-note">${tl("adm.noAccess")}</div>
      </div>`;
    return false;
  }
  return true;
}

/* ---------------- Users ---------------- */

async function renderUsersTab(body) {
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

const MEMBER_ROLES = ["MEMBER", "ADMIN"];

/* ---------------- Per-project, per-member granular permissions ---------------- */
// Mirrors PROJECT_PERMISSIONS / DEFAULT_MEMBER_PERMISSIONS in src/domains/access/rbac.ts.
// Project/super admins always have every permission implicitly; these only
// apply to (and are only shown/editable for) plain MEMBER rows.
const PERMISSION_LABELS = permLabels("perm", [
  "VIEW_ALL_TICKETS", "CREATE_TICKET", "COMMENT_ON_OTHERS_TICKETS", "MOVE_OTHERS_TICKETS",
  "DELETE_TICKET", "MANAGE_MEMBERS", "MANAGE_SPRINTS",
]);
// One-click permission sets. Contributor matches the default for new members.
const PERMISSION_PRESETS = {
  viewer: ["VIEW_ALL_TICKETS"],
  contributor: ["VIEW_ALL_TICKETS", "CREATE_TICKET", "COMMENT_ON_OTHERS_TICKETS"],
  lead: ["VIEW_ALL_TICKETS", "CREATE_TICKET", "COMMENT_ON_OTHERS_TICKETS", "MOVE_OTHERS_TICKETS", "DELETE_TICKET", "MANAGE_MEMBERS", "MANAGE_SPRINTS"],
};
const DEFAULT_MEMBER_PERMS = ["VIEW_ALL_TICKETS", "CREATE_TICKET", "COMMENT_ON_OTHERS_TICKETS"];

function permsBlockHtml(scopeId, available, granted) {
  const perms = available && available.length ? available : Object.keys(PERMISSION_LABELS);
  return `
    <div class="up-perms" data-scope="${esc(scopeId)}" style="display:none;grid-template-columns:1fr 1fr;gap:4px 14px;padding:2px 4px 10px 34px">
      <label class="perm-preset-row" style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-weight:400;font-size:12px;color:var(--text-dim);margin:0 0 2px">
        ${tl("acc.preset")}
        <select class="perm-preset" style="max-width:190px">
          <option value="">${tl("acc.presetPick")}</option>
          ${Object.keys(PERMISSION_PRESETS).map((k) => `<option value="${k}">${tl(`acc.preset.${k}`)}</option>`).join("")}
        </select>
      </label>
      ${perms.map((key) => `
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:12px;color:var(--text-dim);margin:0;cursor:pointer">
          <input type="checkbox" class="perm-cb" value="${esc(key)}" ${granted.includes(key) ? "checked" : ""} />
          ${esc(PERMISSION_LABELS[key] || key)}
        </label>`).join("")}
    </div>`;
}

// Keeps a permission block's visibility/enabled-state in sync with its row's
// membership checkbox and role select. `granted` is that member's saved
// permission set (or DEFAULT_MEMBER_PERMS for a not-yet-a-member row) —
// restored whenever the role flips back to MEMBER from ADMIN.
function wirePermsToggle(row, permsBlock, granted) {
  const cb = row.querySelector("input[type=checkbox]");
  const sel = row.querySelector(".up-role");
  const update = () => {
    const isMember = cb.checked;
    const isAdmin = sel.value === "ADMIN";
    permsBlock.style.display = isMember ? "grid" : "none";
    for (const pcb of permsBlock.querySelectorAll(".perm-cb")) {
      pcb.disabled = isAdmin;
      pcb.checked = isAdmin || granted.includes(pcb.value);
    }
  };
  cb.addEventListener("change", update);
  sel.addEventListener("change", update);
  const preset = permsBlock.querySelector(".perm-preset");
  if (preset) {
    preset.addEventListener("change", () => {
      const set = PERMISSION_PRESETS[preset.value];
      if (!set) return;
      for (const pcb of permsBlock.querySelectorAll(".perm-cb")) if (!pcb.disabled) pcb.checked = set.includes(pcb.value);
      granted = set.slice(); // keep the preset if the role flips back to MEMBER
      preset.value = "";
    });
  }
  update();
}

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

/* ---------------- Projects ---------------- */

async function renderProjectsTab(body) {
  let projects;
  try {
    projects = await loadProjects(true);
  } catch (err) {
    body.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    return;
  }

  const isSuper = state.user.role === "SUPER_ADMIN";

  body.innerHTML = `
    <div class="page-head">
      <span class="spacer" style="flex:1"></span>
      <button class="btn sm" id="new-project-btn">${tl("adm.newProject")}</button>
    </div>
    ${projects.length === 0
      ? `<div class="empty-note">${tl("adm.noProjectsYet")}</div>`
      : `<div class="table-card">
          <table class="data">
            <thead><tr><th>${tl("adm.name")}</th><th>${tl("adm.colPrefix")}</th><th>${tl("adm.colTickets")}</th><th>${tl("adm.created")}</th>${isSuper ? "<th></th>" : ""}</tr></thead>
            <tbody>
              ${projects.map((p) => projectRow(p, isSuper)).join("")}
            </tbody>
          </table>
        </div>
        ${isSuper ? `<div class="mt-total" style="margin-top:10px">${tl("adm.clickProject")}</div>` : ""}`}`;

  body.querySelector("#new-project-btn").addEventListener("click", () => openProjectModal(body));
  for (const btn of body.querySelectorAll("button[data-project-id]")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const p = projects.find((x) => x.id === btn.getAttribute("data-project-id"));
      confirmDeleteProject(body, p);
    });
  }
  if (isSuper) {
    for (const tr of body.querySelectorAll("tr[data-project-id]")) {
      tr.addEventListener("click", () => {
        const p = projects.find((x) => x.id === tr.getAttribute("data-project-id"));
        if (p) openProjectAccessModal(p, () => renderProjectsTab(body));
      });
    }
  }
}

function projectRow(p, isSuper) {
  return `
    <tr data-project-id="${esc(p.id)}" class="${isSuper ? "clickable" : ""}">
      <td><a href="/projects/${encodeURIComponent(p.id)}" data-nav>${esc(p.name)}</a></td>
      <td><span class="prefix-chip">${esc(p.prefix)}</span></td>
      <td>${Number(p.ticketCount ?? 0)}</td>
      <td style="color:var(--text-dim)">${fmtDate(p.createdAt)}</td>
      ${isSuper ? `<td style="text-align:right"><button class="btn danger sm" data-project-id="${esc(p.id)}">${tl("adm.delete")}</button></td>` : ""}
    </tr>`;
}

/* ---------------- Project access (members) modal ---------------- */

async function openProjectAccessModal(p, reload) {
  let data, users;
  try {
    [data, users] = await Promise.all([
      api.get(`/admin/projects/${p.id}/members`),
      api.get("/admin/users"),
    ]);
  } catch (err) {
    toast(err.message, "err");
    return;
  }

  const memberMap = new Map(data.members.map((m) => [m.userId, m.role]));

  openModal({
    title: tl("adm.paTitle"),
    wide: true,
    body: `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <span class="prefix-chip">${esc(p.prefix)}</span>
        <strong>${esc(p.name)}</strong>
        <span style="margin-left:auto;color:var(--text-dim);font-size:12.5px">${tl(data.members.length === 1 ? "adm.member.one" : "adm.member.many", { count: data.members.length })}</span>
      </div>
      <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px">
        ${tl("adm.paHint")}
      </div>
      <div class="field" style="margin-bottom:16px">
        <label for="pm-default-assignee">${tl("adm.paDefaultAssignee")}</label>
        <select id="pm-default-assignee">
          <option value="">${tl("adm.paNone")}</option>
          ${data.members.map((m) => `<option value="${esc(m.userId)}"${p.defaultAssigneeId === m.userId ? " selected" : ""}>${esc(m.name)}</option>`).join("")}
        </select>
        <div style="color:var(--text-dim);font-size:12px;margin-top:6px">
          ${tl("adm.paDefaultNote")}
        </div>
      </div>
      <div class="field" style="margin-bottom:16px">
        <label for="pm-github-repo">${tl("adm.paRepo")}</label>
        <input type="text" id="pm-github-repo" value="${esc(p.githubRepo || "")}" placeholder="owner/name" autocomplete="off" />
        <div style="color:var(--text-dim);font-size:12px;margin-top:6px">
          ${tl("adm.paRepoNote", { example: `<code>${esc(p.prefix)}-12</code>` })}
        </div>
      </div>
      <div id="pm-users">
        ${users.map((u) => {
          const memberRole = memberMap.get(u.id);
          const global = u.role === "SUPER_ADMIN";
          const checked = memberRole !== undefined || global;
          const existing = data.members.find((m) => m.userId === u.id);
          const granted = existing ? (existing.permissions || []) : DEFAULT_MEMBER_PERMS;
          return `
          <div class="up-block" style="border-bottom:1px solid var(--border)${global ? ";opacity:.75" : ""}">
          <div class="up-row" data-user="${esc(u.id)}"${global ? ' data-global="1"' : ""} style="display:flex;align-items:center;gap:10px;padding:7px 4px">
            <input type="checkbox" id="pm-${esc(u.id)}" ${checked ? "checked" : ""}${global ? " disabled" : ""} />
            <label for="pm-${esc(u.id)}" style="flex:1;display:flex;align-items:center;gap:8px;margin:0;cursor:${global ? "default" : "pointer"};font-weight:400;color:var(--text);font-size:13.5px">
              ${avatarHtml(u.name, u.id)} ${esc(u.name)}
              <span style="color:var(--text-dim);font-size:12px">· ${esc(u.email)}</span>
            </label>
            ${global
              ? `<span style="font-size:11.5px;color:var(--text-dim)">${tl("adm.paGlobal", { role: tl(`role.${u.role}`) })}</span>`
              : `<select class="up-role" ${memberRole ? "" : "disabled"} style="max-width:120px">
                  ${MEMBER_ROLES.map((r) => `<option value="${r}"${(memberRole || "MEMBER") === r ? " selected" : ""}>${tl(`role.${r}`)}</option>`).join("")}
                </select>`}
          </div>
          ${global ? "" : permsBlockHtml(u.id, data.availablePermissions, granted)}
          </div>`;
        }).join("")}
        ${users.length === 0 ? `<div class="empty-note">${tl("adm.noUsers")}</div>` : ""}
      </div>
      <div class="modal-actions">
        <span class="ro-note">${tl("adm.paApply")}</span>
        <span class="right">
          <button class="btn ghost" id="pm-cancel">${tl("adm.cancel")}</button>
          <button class="btn" id="pm-save">${tl("adm.save")}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      for (const row of modalEl.querySelectorAll(".up-row")) {
        if (row.dataset.global) continue;
        const cb = row.querySelector("input[type=checkbox]");
        const sel = row.querySelector(".up-role");
        cb.addEventListener("change", () => { sel.disabled = !cb.checked; });
        const userId = row.dataset.user;
        const existing = data.members.find((m) => m.userId === userId);
        const permsBlock = modalEl.querySelector(`.up-perms[data-scope="${CSS.escape(userId)}"]`);
        wirePermsToggle(row, permsBlock, existing ? (existing.permissions || []) : DEFAULT_MEMBER_PERMS);
      }

      modalEl.querySelector("#pm-cancel").addEventListener("click", close);

      modalEl.querySelector("#pm-save").addEventListener("click", async () => {
        const saveBtn = modalEl.querySelector("#pm-save");
        saveBtn.disabled = true;
        try {
          const newDefaultAssignee = modalEl.querySelector("#pm-default-assignee").value;
          if (newDefaultAssignee !== (p.defaultAssigneeId || "")) {
            await api.patch(`/projects/${p.id}`, { defaultAssigneeId: newDefaultAssignee || null });
          }
          const newRepo = modalEl.querySelector("#pm-github-repo").value.trim();
          if (newRepo !== (p.githubRepo || "")) {
            await api.patch(`/projects/${p.id}/github`, { repo: newRepo || null });
          }
          for (const row of modalEl.querySelectorAll(".up-row")) {
            if (row.dataset.global) continue;
            const userId = row.dataset.user;
            const checked = row.querySelector("input[type=checkbox]").checked;
            const role = row.querySelector(".up-role").value;
            const original = memberMap.get(userId);
            if (checked && original !== role) {
              await api.post(`/admin/projects/${p.id}/members`, { userId, role });
            } else if (!checked && original !== undefined) {
              await api.del(`/admin/projects/${p.id}/members/${userId}`);
            }
            if (checked && role === "MEMBER") {
              const permsBlock = modalEl.querySelector(`.up-perms[data-scope="${CSS.escape(userId)}"]`);
              const selected = [...permsBlock.querySelectorAll(".perm-cb:checked")].map((cb2) => cb2.value);
              await api.patch(`/admin/projects/${p.id}/members/${userId}/permissions`, { permissions: selected });
            }
          }
          toast(tl("adm.paSaved", { prefix: p.prefix }), "ok");
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

function openProjectModal(body) {
  openModal({
    title: tl("adm.npTitle"),
    body: `
      <div class="field">
        <label for="np-name">${tl("adm.name")}</label>
        <input type="text" id="np-name" placeholder="e.g. Web Core" />
      </div>
      <div class="field">
        <label for="np-prefix">${tl("adm.colPrefix")}</label>
        <input type="text" id="np-prefix" placeholder="e.g. WCE" maxlength="5" />
        <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("adm.npPrefixNote", { example: "WCE-1, WCE-2" })}</div>
      </div>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="np-cancel">${tl("adm.cancel")}</button>
          <button class="btn" id="np-save">${tl("adm.create")}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      modalEl.querySelector("#np-cancel").addEventListener("click", close);
      const save = modalEl.querySelector("#np-save");
      save.addEventListener("click", async () => {
        const payload = {
          name: modalEl.querySelector("#np-name").value.trim(),
          prefix: modalEl.querySelector("#np-prefix").value.trim().toUpperCase(),
        };
        save.disabled = true;
        try {
          await api.post("/projects", payload);
          toast(tl("adm.npCreated", { name: payload.name }), "ok");
          close();
          state.projectsCache = null;
          await renderProjectsTab(body);
        } catch (err) {
          save.disabled = false;
          toast(err.message, "err");
        }
      });
    },
  });
}

function confirmDeleteProject(body, p) {
  openModal({
    title: tl("adm.dpTitle"),
    body: `
      <p>${tl("adm.dpBody", { name: `<strong>${esc(p.name)}</strong>`, prefix: esc(p.prefix) })}</p>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="dp-cancel">${tl("adm.cancel")}</button>
          <button class="btn danger" id="dp-confirm">${tl("adm.delete")}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      modalEl.querySelector("#dp-cancel").addEventListener("click", close);
      modalEl.querySelector("#dp-confirm").addEventListener("click", async () => {
        try {
          await api.del(`/projects/${p.id}`);
          toast(tl("adm.dpDone", { prefix: p.prefix }), "ok");
          close();
          state.projectsCache = null;
          await renderProjectsTab(body);
        } catch (err) {
          toast(err.message, "err");
        }
      });
    },
  });
}

/* ---------------- Access overview + audit log ---------------- */

const AUDIT_ACTIONS = ["ROLE_CHANGED", "MEMBER_ADDED", "MEMBER_ROLE_CHANGED", "MEMBER_REMOVED", "PERMISSIONS_CHANGED", "ACCOUNT_DELETED"];

function auditDetail(e) {
  const d = e.detail || {};
  const role = (r) => (r ? tl(`role.${r}`) : "-");
  if (e.action === "ROLE_CHANGED" || e.action === "MEMBER_ROLE_CHANGED") return `${role(d.from)} → ${role(d.to)}`;
  if (e.action === "MEMBER_ADDED") return role(d.to);
  if (e.action === "MEMBER_REMOVED") return role(d.from);
  if (e.action === "PERMISSIONS_CHANGED") {
    const names = (list) => (list || []).map((p) => PERMISSION_LABELS[p] || p);
    const added = (d.to || []).filter((p) => !(d.from || []).includes(p));
    const removed = (d.from || []).filter((p) => !(d.to || []).includes(p));
    return [...names(added).map((n) => `+ ${n}`), ...names(removed).map((n) => `− ${n}`)].join("; ") || "-";
  }
  return "";
}

async function renderAccessTab(body) {
  if (state.user.role !== "SUPER_ADMIN") {
    body.innerHTML = `<div class="empty-note">${tl("adm.sOnlySuper")}</div>`;
    return;
  }
  let data, audit, projects;
  try {
    [data, audit, projects] = await Promise.all([api.get("/admin/access"), api.get("/admin/audit?limit=100"), loadProjects(true)]);
  } catch (err) {
    body.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    return;
  }
  const memberOf = new Map(data.memberships.map((m) => [`${m.userId}:${m.projectId}`, m]));

  const cell = (u, p) => {
    if (u.role === "SUPER_ADMIN") return `<td class="acc-cell acc-all" title="${tl("acc.superAll")}">${tl("acc.all")}</td>`;
    const m = memberOf.get(`${u.id}:${p.id}`);
    const val = m ? m.role : "";
    return `<td class="acc-cell">
      <select class="acc-select acc-${val || "none"}" data-user="${esc(u.id)}" data-project="${esc(p.id)}" data-prev="${val}" aria-label="${esc(u.name)} / ${esc(p.prefix)}">
        <option value="">—</option>
        <option value="MEMBER"${val === "MEMBER" ? " selected" : ""}>${tl("role.MEMBER")}</option>
        <option value="ADMIN"${val === "ADMIN" ? " selected" : ""}>${tl("role.ADMIN")}</option>
      </select>
      ${m && m.role === "MEMBER" ? `<span class="acc-perms" title="${esc(m.permissions.map((x) => PERMISSION_LABELS[x] || x).join(", "))}">${m.permissions.length}/${Object.keys(PERMISSION_LABELS).length}</span>` : ""}
    </td>`;
  };

  body.innerHTML = `
    <div class="mt-total" style="margin-bottom:10px">${tl("acc.overviewHint")}</div>
    <div class="table-card" style="overflow-x:auto">
      <table class="data acc-table">
        <thead><tr>
          <th>${tl("adm.name")}</th><th>${tl("adm.role")}</th>
          ${data.projects.map((p) => `<th><button type="button" class="th-sort" data-open-project="${esc(p.id)}" title="${tl("acc.managePerms")}"><span class="prefix-chip">${esc(p.prefix)}</span></button></th>`).join("")}
        </tr></thead>
        <tbody>${data.users.map((u) => `<tr>
          <td>${avatarHtml(u.name, u.id)} ${esc(u.name)}<div style="color:var(--text-dim);font-size:12px">${esc(u.email)}</div></td>
          <td>${roleChip(u.role)}</td>
          ${data.projects.map((p) => cell(u, p)).join("")}
        </tr>`).join("")}</tbody>
      </table>
    </div>

    <h3 class="settings-heading" style="margin-top:24px">${tl("acc.auditTitle")}</h3>
    ${audit.length === 0 ? `<div class="empty-note">${tl("acc.auditEmpty")}</div>` : `
    <div class="table-card" style="overflow-x:auto">
      <table class="data">
        <thead><tr><th>${tl("acc.when")}</th><th>${tl("acc.who")}</th><th>${tl("acc.what")}</th><th>${tl("acc.target")}</th><th>${tl("acc.project")}</th><th>${tl("acc.detail")}</th></tr></thead>
        <tbody>${audit.map((e) => `<tr>
          <td style="color:var(--text-dim);white-space:nowrap">${fmtDate(e.createdAt)}</td>
          <td>${esc(e.actorName || "?")}</td>
          <td>${AUDIT_ACTIONS.includes(e.action) ? tl(`acc.action.${e.action}`) : esc(e.action)}</td>
          <td>${esc(e.targetName || "?")}</td>
          <td>${e.projectPrefix ? `<span class="prefix-chip">${esc(e.projectPrefix)}</span>` : "-"}</td>
          <td style="font-size:12.5px">${esc(auditDetail(e))}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>`}`;

  for (const sel of body.querySelectorAll(".acc-select")) {
    sel.addEventListener("change", async () => {
      const { user: userId, project: projectId, prev } = sel.dataset;
      sel.disabled = true;
      try {
        if (!sel.value) await api.del(`/admin/projects/${projectId}/members/${userId}`);
        else await api.post(`/admin/projects/${projectId}/members`, { userId, role: sel.value });
        toast(tl("acc.saved"), "ok");
        await renderAccessTab(body);
      } catch (err) {
        toast(err.message, "err");
        sel.value = prev;
        sel.disabled = false;
      }
    });
  }
  for (const btn of body.querySelectorAll("[data-open-project]")) {
    btn.addEventListener("click", () => {
      const p = projects.find((x) => x.id === btn.dataset.openProject);
      if (p) openProjectAccessModal(p, () => renderAccessTab(body));
    });
  }
}

/* ---------------- Settings ---------------- */

async function renderSettingsTab(body) {
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
