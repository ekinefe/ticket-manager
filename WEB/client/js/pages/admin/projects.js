import { api } from "../../api.js";
import { loadProjects, state } from "../../main.js";
import { esc, avatarHtml, fmtDate, openModal, toast } from "../../ui.js";
import { t as tl } from "../../i18n.js";
import { MEMBER_ROLES } from "./users.js";
import { DEFAULT_MEMBER_PERMS, permsBlockHtml, wirePermsToggle } from "./perms.js";

/* ---------------- Projects ---------------- */

export async function renderProjectsTab(body) {
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

export async function openProjectAccessModal(p, reload) {
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
