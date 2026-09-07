import { api } from "../api.js";
import { navigate } from "../main.js";
import {
  esc, priorityPill, branchName, toast, statusPill,
  STATUSES, getStatusColor, STATUS_LABELS,
  TASK_TYPES, TYPE_LABELS, PRIORITIES, PRIORITY_LABELS,
} from "../ui.js";

let selectedIds = new Set();
let viewMode = localStorage.getItem("tm-ticket-view") || "board";

export async function renderMyTickets(root) {
  root.innerHTML = `<div class="page"><div class="spinner"></div></div>`;

  let tickets;
  try {
    tickets = await api.get("/my-tickets");
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }

  const known = new Set(tickets.map((t) => t.id));
  for (const id of [...selectedIds]) if (!known.has(id)) selectedIds.delete(id);

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
        <div class="btn-group view-toggle" role="group" aria-label="View" style="margin-left:auto">
          <button class="btn sm ${viewMode === "board" ? "" : "ghost"}" id="view-board-btn">Board</button>
          <button class="btn sm ${viewMode === "list" ? "" : "ghost"}" id="view-list-btn">List</button>
        </div>
      </div>
      ${groups.size === 0
        ? `<div class="empty-note">No tickets are assigned to you. Assigned tickets from every project will show up here.</div>`
        : [...groups.entries()].map(([projectId, g]) => projectSection(projectId, g)).join("")}
      <div class="bulk-bar hidden" id="bulk-bar"></div>
    </div>`;

  root.querySelector("#view-board-btn").addEventListener("click", () => { if (viewMode !== "board") { viewMode = "board"; localStorage.setItem("tm-ticket-view", "board"); renderMyTickets(root); } });
  root.querySelector("#view-list-btn").addEventListener("click", () => { if (viewMode !== "list") { viewMode = "list"; localStorage.setItem("tm-ticket-view", "list"); renderMyTickets(root); } });

  bindRows(root);
  renderBulkBar(root);
}

function bindRows(root) {
  for (const card of root.querySelectorAll(".mt-card, .list-row")) {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".card-select")) return;
      navigate(`/projects/${card.dataset.project}`);
    });
    const cb = card.querySelector(".card-select");
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) selectedIds.add(card.dataset.id);
      else selectedIds.delete(card.dataset.id);
      card.classList.toggle("selected", cb.checked);
      renderBulkBar(root);
    });
  }
}

function renderBulkBar(root) {
  const bar = root.querySelector("#bulk-bar");
  if (!bar) return;
  if (selectedIds.size === 0) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <span class="bulk-count">${selectedIds.size} selected</span>
    <select id="bulk-status">
      <option value="">Move to status…</option>
      ${STATUSES.map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join("")}
    </select>
    <select id="bulk-type">
      <option value="">Change type…</option>
      ${TASK_TYPES.map((t) => `<option value="${t}">${TYPE_LABELS[t]}</option>`).join("")}
    </select>
    <select id="bulk-priority">
      <option value="">Change priority…</option>
      ${PRIORITIES.map((p) => `<option value="${p}">${PRIORITY_LABELS[p]}</option>`).join("")}
    </select>
    <button class="btn sm ghost" id="bulk-clear">Clear selection</button>`;

  const apply = async (update, selectEl) => {
    const taskIds = [...selectedIds];
    selectEl.disabled = true;
    try {
      const { updated, skipped } = await api.patch("/tasks/bulk", { taskIds, update });
      if (skipped.length === 0) {
        toast(`Updated ${updated.length} ticket${updated.length === 1 ? "" : "s"}`, "ok");
      } else {
        toast(`Updated ${updated.length}, skipped ${skipped.length} (no permission or invalid change)`, updated.length ? "ok" : "err");
      }
      selectedIds = new Set();
      await renderMyTickets(root);
    } catch (err) {
      toast(err.message || "Bulk update failed", "err");
      selectEl.disabled = false;
      selectEl.value = "";
    }
  };

  bar.querySelector("#bulk-status").addEventListener("change", (e) => apply({ status: e.target.value }, e.target));
  bar.querySelector("#bulk-type").addEventListener("change", (e) => apply({ type: e.target.value }, e.target));
  bar.querySelector("#bulk-priority").addEventListener("change", (e) => apply({ priority: e.target.value }, e.target));
  bar.querySelector("#bulk-clear").addEventListener("click", () => {
    selectedIds = new Set();
    renderMyTickets(root);
  });
}

function projectSection(projectId, g) {
  return `
    <section class="mt-project">
      <div class="mt-head">
        <span class="prefix-chip">${esc(g.prefix)}</span>
        <h2><a href="/projects/${encodeURIComponent(projectId)}" data-nav>${esc(g.name)}</a></h2>
        <span class="mt-count">${g.tasks.length} ticket${g.tasks.length === 1 ? "" : "s"}</span>
      </div>
      ${viewMode === "list" ? listTableHtml(projectId, g.tasks) : boardHtml(g.tasks)}
    </section>`;
}

function boardHtml(tasks) {
  const cols = STATUSES
    .map((s) => ({ status: s, list: tasks.filter((t) => t.status === s) }))
    .filter((c) => c.list.length > 0);
  return `
    <div class="mt-board">
      ${cols.map((c) => `
        <div class="column mt-col" data-status="${c.status}">
          <header class="col-head">
            <span class="col-dot" style="background:${getStatusColor(c.status)}"></span>
            <span class="col-label">${STATUS_LABELS[c.status]}</span>
            <span class="col-count">${c.list.length}</span>
          </header>
          <div class="col-body">
            ${c.list.map((t) => cardHtml(t)).join("")}
          </div>
        </div>`).join("")}
    </div>`;
}

function listTableHtml(projectId, tasks) {
  return `
    <table class="data list-table">
      <thead><tr><th></th><th>Ticket</th><th>Title</th><th>Status</th><th>Type</th><th>Priority</th></tr></thead>
      <tbody>${tasks.map((t) => listRowHtml(projectId, t)).join("")}</tbody>
    </table>`;
}

function listRowHtml(projectId, t) {
  const checked = selectedIds.has(t.id);
  return `
    <tr class="list-row${checked ? " selected" : ""}" data-id="${esc(t.id)}" data-project="${esc(projectId)}" title="Open in ${esc(t.projectName)} board">
      <td><input type="checkbox" class="card-select" data-select="${esc(t.id)}" ${checked ? "checked" : ""} title="Select ticket" /></td>
      <td class="ticket-id">${esc(t.ticketId)}</td>
      <td class="title-cell">${esc(t.title)}</td>
      <td>${statusPill(t.status)}</td>
      <td>${TYPE_LABELS[t.type]}</td>
      <td>${priorityPill(t.priority)}</td>
    </tr>`;
}

function cardHtml(t) {
  const checked = selectedIds.has(t.id);
  return `
    <article class="card mt-card${checked ? " selected" : ""}" data-id="${esc(t.id)}" data-project="${esc(t.projectId)}" title="Open in ${esc(t.projectName)} board">
      <div class="row">
        <input type="checkbox" class="card-select" data-select="${esc(t.id)}" ${checked ? "checked" : ""} title="Select ticket" />
        <span class="ticket-id">${esc(t.ticketId)}</span>
        <span class="card-meta">${priorityPill(t.priority)}</span>
      </div>
      <p class="title">${esc(t.title)}</p>
      ${t.ticketId ? `<div class="branch-line"><span class="branch-ico">&#9123;</span>${esc(branchName(t))}</div>` : ""}
    </article>`;
}
