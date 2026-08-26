import { api } from "../api.js";
import { loadProjects, state } from "../main.js";
import { esc, roleChip, statusPill, STATUSES } from "../ui.js";

export async function renderProjects(root) {
  root.innerHTML = `<div class="page"><div class="spinner"></div></div>`;

  let projects;
  try {
    projects = await loadProjects(true);
  } catch (err) {
    if (err.status === 401) { state.user = null; navigate("/login"); return; }
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }

  const isSuper = state.user.role === "SUPER_ADMIN";

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h1>Projects</h1>
        <span class="spacer" style="flex:1"></span>
        ${isSuper || state.user.role === "ADMIN" ? `<a class="btn sm" href="/admin/projects" data-nav>+ New project</a>` : ""}
      </div>
      ${projects.length === 0
        ? `<div class="empty-note">No projects yet.${isSuper ? " Create one from the admin panel." : " Ask an admin to invite you."}</div>`
        : `<div class="project-list">
            ${projects.map((p) => projectRow(p, isSuper)).join("")}
          </div>`}
    </div>`;
}

function projectRow(p, isSuper) {
  const myRole = p.role ?? (isSuper ? "ADMIN" : null);
  const counts = p.statusCounts || {};
  const tickets = Number(p.ticketCount ?? 0);
  const breakdown = STATUSES
    .filter((s) => counts[s] > 0)
    .map((s) => statusPill(s, counts[s]))
    .join("");
  return `
    <a class="project-row" href="/projects/${encodeURIComponent(p.id)}" data-nav>
      <span class="row-top">
        <span class="name">${esc(p.name)}</span>
        <span class="prefix-chip">${esc(p.prefix)}</span>
        <span class="total" title="Total tickets">${tickets} ticket${tickets === 1 ? "" : "s"}</span>
        <span class="meta">
          ${roleChip(myRole)}
          <span class="arrow">Open board &rarr;</span>
        </span>
      </span>
      <span class="row-tags">
        ${breakdown || `<span style="color:var(--text-dim)">No tickets</span>`}
      </span>
    </a>`;
}
