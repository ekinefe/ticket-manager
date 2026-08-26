import { api } from "../api.js";
import { loadProjects, state } from "../main.js";
import { esc, avatarHtml, roleChip, fmtDate, openModal, toast } from "../ui.js";
const ROLES = ["USER", "ADMIN", "SUPER_ADMIN"];

export async function renderAdmin(root, section = "users") {
  if (!requireAdminAccess(root)) return;

  root.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Admin Panel</h1></div>
      <nav class="tabs">
        <a class="tab${section === "users" ? " active" : ""}" href="/admin/users" data-nav>Users</a>
        <a class="tab${section === "projects" ? " active" : ""}" href="/admin/projects" data-nav>Projects</a>
      </nav>
      <div id="admin-body"><div class="spinner"></div></div>
    </div>`;

  const body = root.querySelector("#admin-body");
  if (section === "projects") await renderProjectsTab(body);
  else await renderUsersTab(body);
}

function requireAdminAccess(root) {
  if (state.user.role === "USER") {
    root.innerHTML = `
      <div class="page">
        <h1>Admin Panel</h1>
        <div class="empty-note">You do not have permission to view this page.</div>
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
    ? `<div class="empty-note">No users yet.</div>`
    : `<div class="table-card">
        <table class="data">
          <thead><tr><th>Name</th><th>E-mail</th><th>Role</th><th>Created</th></tr></thead>
          <tbody>
            ${users.map((u) => userRow(u, isSuper)).join("")}
          </tbody>
        </table>
      </div>
      ${isSuper ? `<div class="mt-total" style="margin-top:10px">Click a user to manage their role and projects.</div>` : ""}`;

  if (!isSuper) return;

  const head = document.createElement("div");
  head.className = "page-head";
  head.style.marginBottom = "14px";
  head.innerHTML = `
    <span class="spacer" style="flex:1"></span>
    <button class="btn sm" id="invite-user-btn">+ Invite user</button>`;
  body.prepend(head);
  head.querySelector("#invite-user-btn").addEventListener("click", () =>
    openInviteUserModal(() => renderUsersTab(body))
  );

  for (const tr of body.querySelectorAll("tr[data-user-id]")) {
    tr.addEventListener("click", () => {
      const u = users.find((x) => x.id === tr.getAttribute("data-user-id"));
      if (u) openUserModal(u, () => renderUsersTab(body));
    });
  }
}

function confirmDeleteUser(u, reload, closeEditor) {
  openModal({
    title: "Delete user",
    body: `
      <p>
        Delete the account of <strong>${esc(u.name)}</strong> (${esc(u.email)})?
        They will be removed from all projects and their tickets will become unassigned.
        This cannot be undone.
      </p>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="du-cancel">Cancel</button>
          <button class="btn danger" id="du-confirm">Delete</button>
        </span>
      </div>`,
    onMount(modalEl, closeConfirm) {
      modalEl.querySelector("#du-cancel").addEventListener("click", closeConfirm);
      modalEl.querySelector("#du-confirm").addEventListener("click", async () => {
        try {
          await api.del(`/admin/users/${u.id}`);
          toast(`Account ${u.email} deleted`, "ok");
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

/* ---------------- Invite user ---------------- */

function openInviteUserModal(reload) {
  openModal({
    title: "Invite user",
    body: `
      <div class="field">
        <label for="iu-email">E-mail</label>
        <input type="email" id="iu-email" placeholder="name@company.com" autocomplete="off" />
        <div style="color:var(--text-dim);font-size:12px;margin-top:6px">
          They will receive a single-use link valid for 48 hours to set their own password.
          Assign projects afterwards from this list.
        </div>
      </div>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="iu-cancel">Cancel</button>
          <button class="btn" id="iu-send">Send invite</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      const body = modalEl.querySelector(".modal-body") || modalEl;
      const send = async () => {
        const email = body.querySelector("#iu-email").value.trim();
        try {
          const res = await api.post("/admin/invites", { email });
          toast(`Invite sent to ${email}`, "ok");
          reload();
          showInviteLink(modalEl, close, res.devInviteUrl);
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
    <p style="margin-top:0">Invitation sent. In local development no mail server runs, so copy the invite link:</p>
    <div style="display:flex;gap:8px">
      <input type="text" id="iu-link" value="${esc(url)}" readonly style="font-size:12px" />
      <button class="btn sm ghost" id="iu-copy">Copy</button>
    </div>
    <div class="modal-actions">
      <span></span>
      <span class="right"><button class="btn" id="iu-done">Done</button></span>
    </div>`;
  body.querySelector("#iu-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied", "ok");
    } catch {
      body.querySelector("#iu-link").select();
    }
  });
  body.querySelector("#iu-done").addEventListener("click", close);
}

function userRow(u, isSuper) {
  const isSelf = u.id === state.user.id;
  const roleCell = `${roleChip(u.role)}${isSelf ? ` <span style="color:var(--text-dim);font-size:12px">(you)</span>` : ""}`;
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
    title: "Manage user",
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
        <label for="um-role">Global role</label>
        ${isSelf
          ? `<div style="font-size:13px;padding:2px 0">${roleChip(detail.role)} <span style="color:var(--text-dim);font-size:12.5px">You cannot change your own role.</span></div>`
          : `<select id="um-role">
              ${ROLES.map((r) => `<option value="${r}"${r === detail.role ? " selected" : ""}>${r}</option>`).join("")}
            </select>`}
      </div>

      <div class="field" style="margin-bottom:6px">
        <label>Project access</label>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px">Check the projects this user can access; pick their project role.</div>
      </div>
      <div id="um-projects">
        ${projects.map((p) => {
          const memberRole = memberships.get(p.id);
          return `
          <div class="up-row" data-project="${esc(p.id)}" style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--border)">
            <input type="checkbox" id="up-${esc(p.id)}" ${memberRole ? "checked" : ""} />
            <label for="up-${esc(p.id)}" style="flex:1;display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;font-weight:400;color:var(--text);font-size:13.5px">
              <span class="prefix-chip">${esc(p.prefix)}</span> ${esc(p.name)}
            </label>
            <select class="up-role" ${memberRole ? "" : "disabled"} style="max-width:120px">
              ${MEMBER_ROLES.map((r) => `<option value="${r}"${(memberRole || "MEMBER") === r ? " selected" : ""}>${r}</option>`).join("")}
            </select>
          </div>`;
        }).join("")}
        ${projects.length === 0 ? `<div class="empty-note">No projects exist yet.</div>` : ""}
      </div>

      <div class="modal-actions">
        ${isSelf ? "<span></span>" : `<button class="btn danger" id="um-delete">Delete user</button>`}
        <span class="right">
          <button class="btn ghost" id="um-cancel">Cancel</button>
          <button class="btn" id="um-save">Save</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      const delBtn = modalEl.querySelector("#um-delete");
      if (delBtn) delBtn.addEventListener("click", () => confirmDeleteUser(detail, reload, close));
      // enable/disable the project role select with the checkbox
      for (const row of modalEl.querySelectorAll(".up-row")) {
        const cb = row.querySelector("input[type=checkbox]");
        const sel = row.querySelector(".up-role");
        cb.addEventListener("change", () => { sel.disabled = !cb.checked; });
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
          }
          toast(`Saved changes for ${detail.name}`, "ok");
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
      <button class="btn sm" id="new-project-btn">+ New project</button>
    </div>
    ${projects.length === 0
      ? `<div class="empty-note">No projects yet. Create the first one.</div>`
      : `<div class="table-card">
          <table class="data">
            <thead><tr><th>Name</th><th>Prefix</th><th>Tickets</th><th>Created</th>${isSuper ? "<th></th>" : ""}</tr></thead>
            <tbody>
              ${projects.map((p) => projectRow(p, isSuper)).join("")}
            </tbody>
          </table>
        </div>
        ${isSuper ? `<div class="mt-total" style="margin-top:10px">Click a project to manage who can access it.</div>` : ""}`}`;

  body.querySelector("#new-project-btn").addEventListener("click", () => openProjectModal(body));
  for (const btn of body.querySelectorAll("button[data-project-id]")) {
    btn.addEventListener("click", () => {
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
      ${isSuper ? `<td style="text-align:right"><button class="btn danger sm" data-project-id="${esc(p.id)}">Delete</button></td>` : ""}
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
    title: "Project access",
    wide: true,
    body: `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <span class="prefix-chip">${esc(p.prefix)}</span>
        <strong>${esc(p.name)}</strong>
        <span style="margin-left:auto;color:var(--text-dim);font-size:12.5px">${data.members.length} member${data.members.length === 1 ? "" : "s"}</span>
      </div>
      <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px">
        Check who can access this project and pick their project role.
        Super Admins have access to every project; everyone else needs a
        membership below. Global Admins manage users and create projects but
        still need membership to open a project.
      </div>
      <div id="pm-users">
        ${users.map((u) => {
          const memberRole = memberMap.get(u.id);
          const global = u.role === "SUPER_ADMIN";
          const checked = memberRole !== undefined || global;
          return `
          <div class="up-row" data-user="${esc(u.id)}"${global ? ' data-global="1"' : ""} style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--border)${global ? ";opacity:.75" : ""}">
            <input type="checkbox" id="pm-${esc(u.id)}" ${checked ? "checked" : ""}${global ? " disabled" : ""} />
            <label for="pm-${esc(u.id)}" style="flex:1;display:flex;align-items:center;gap:8px;margin:0;cursor:${global ? "default" : "pointer"};font-weight:400;color:var(--text);font-size:13.5px">
              ${avatarHtml(u.name, u.id)} ${esc(u.name)}
              <span style="color:var(--text-dim);font-size:12px">· ${esc(u.email)}</span>
            </label>
            ${global
              ? `<span style="font-size:11.5px;color:var(--text-dim)">global ${esc(u.role)}</span>`
              : `<select class="up-role" ${memberRole ? "" : "disabled"} style="max-width:120px">
                  ${MEMBER_ROLES.map((r) => `<option value="${r}"${(memberRole || "MEMBER") === r ? " selected" : ""}>${r}</option>`).join("")}
                </select>`}
          </div>`;
        }).join("")}
        ${users.length === 0 ? `<div class="empty-note">No users yet.</div>` : ""}
      </div>
      <div class="modal-actions">
        <span class="ro-note">Changes apply when you save.</span>
        <span class="right">
          <button class="btn ghost" id="pm-cancel">Cancel</button>
          <button class="btn" id="pm-save">Save</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      for (const row of modalEl.querySelectorAll(".up-row")) {
        if (row.dataset.global) continue;
        const cb = row.querySelector("input[type=checkbox]");
        const sel = row.querySelector(".up-role");
        cb.addEventListener("change", () => { sel.disabled = !cb.checked; });
      }

      modalEl.querySelector("#pm-cancel").addEventListener("click", close);

      modalEl.querySelector("#pm-save").addEventListener("click", async () => {
        const saveBtn = modalEl.querySelector("#pm-save");
        saveBtn.disabled = true;
        try {
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
          }
          toast(`Saved access for ${p.prefix}`, "ok");
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
    title: "New project",
    body: `
      <div class="field">
        <label for="np-name">Name</label>
        <input type="text" id="np-name" placeholder="e.g. Web Core" />
      </div>
      <div class="field">
        <label for="np-prefix">Prefix</label>
        <input type="text" id="np-prefix" placeholder="e.g. WCE" maxlength="5" />
        <div style="color:var(--text-dim);font-size:12px;margin-top:4px">2-5 uppercase letters/digits; ticket IDs become WCE-1, WCE-2 …</div>
      </div>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="np-cancel">Cancel</button>
          <button class="btn" id="np-save">Create</button>
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
          toast(`Project ${payload.name} created`, "ok");
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
    title: "Delete project",
    body: `
      <p>Delete <strong>${esc(p.name)}</strong> (${esc(p.prefix)}) and all of its tickets? This cannot be undone.</p>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="dp-cancel">Cancel</button>
          <button class="btn danger" id="dp-confirm">Delete</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      modalEl.querySelector("#dp-cancel").addEventListener("click", close);
      modalEl.querySelector("#dp-confirm").addEventListener("click", async () => {
        try {
          await api.del(`/projects/${p.id}`);
          toast(`Project ${p.prefix} deleted`, "ok");
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
