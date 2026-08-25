import { api } from "../api.js";
import { navigate } from "../main.js";
import {
  esc, priorityPill, branchName,
  STATUSES, STATUS_COLORS, STATUS_LABELS,
} from "../ui.js";

export async function renderMyTickets(root) {
  root.innerHTML = `<div class="page"><div class="spinner"></div></div>`;

  let tickets;
  try {
    tickets = await api.get("/my-tickets");
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }

  const groups = new Map();
  for (const t of tickets) {
    if (!groups.has(t.projectId)) {
      groups.set(t.projectId, { name: t.projectName, prefix: t.projectPrefix, tasks: [] });
    }
    groups.get(t.projectId).tasks.push(t);
  }

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h1>My Tickets</h1>
        <span class="mt-total">${tickets.length} assigned to you</span>
      </div>
      ${groups.size === 0
        ? `<div class="empty-note">No tickets are assigned to you. Assigned tickets from every project will show up here.</div>`
        : [...groups.entries()].map(([projectId, g]) => projectSection(projectId, g)).join("")}
    </div>`;

  for (const card of root.querySelectorAll(".mt-card")) {
    card.addEventListener("click", () => navigate(`/projects/${card.dataset.project}`));
  }
}

function projectSection(projectId, g) {
  const cols = STATUSES
    .map((s) => ({ status: s, list: g.tasks.filter((t) => t.status === s) }))
    .filter((c) => c.list.length > 0);

  return `
    <section class="mt-project">
      <div class="mt-head">
        <span class="prefix-chip">${esc(g.prefix)}</span>
        <h2><a href="/projects/${encodeURIComponent(projectId)}" data-nav>${esc(g.name)}</a></h2>
        <span class="mt-count">${g.tasks.length} ticket${g.tasks.length === 1 ? "" : "s"}</span>
      </div>
      <div class="mt-board">
        ${cols.map((c) => `
          <div class="column mt-col" data-status="${c.status}">
            <header class="col-head">
              <span class="col-dot" style="background:${STATUS_COLORS[c.status]}"></span>
              <span class="col-label">${STATUS_LABELS[c.status]}</span>
              <span class="col-count">${c.list.length}</span>
            </header>
            <div class="col-body">
              ${c.list.map((t) => cardHtml(t)).join("")}
            </div>
          </div>`).join("")}
      </div>
    </section>`;
}

function cardHtml(t) {
  return `
    <article class="card mt-card" data-id="${esc(t.id)}" data-project="${esc(t.projectId)}" title="Open in ${esc(t.projectName)} board">
      <div class="row">
        <span class="ticket-id">${esc(t.ticketId)}</span>
        <span class="card-meta">${priorityPill(t.priority)}</span>
      </div>
      <p class="title">${esc(t.title)}</p>
      ${t.ticketId ? `<div class="branch-line"><span class="branch-ico">&#9123;</span>${esc(branchName(t))}</div>` : ""}
    </article>`;
}
