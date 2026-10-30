import { api } from "../../api.js";
import { loadProjects, state } from "../../main.js";
import { esc, avatarHtml, roleChip, fmtDate, toast } from "../../ui.js";
import { t as tl } from "../../i18n.js";
import { PERMISSION_LABELS } from "./perms.js";
import { openProjectAccessModal } from "./projects.js";

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

export async function renderAccessTab(body) {
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
