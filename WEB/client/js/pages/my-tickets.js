import { api } from "../api.js";
import { navigate } from "../main.js";
import {
  esc, priorityPill, branchName, toast, statusPill, bulkDeleteTickets,
  STATUSES, getStatusColor, STATUS_LABELS,
  TASK_TYPES, TYPE_LABELS, PRIORITIES, PRIORITY_LABELS,
} from "../ui.js";

let selectedIds = new Set();
let viewMode = localStorage.getItem("tm-ticket-view") || "board";

let allAssignee = "";

export function renderMyTickets(root) { return renderTickets(root, "mine"); }
export function renderAllTickets(root) { return renderTickets(root, "all"); }

async function renderTickets(root, mode) {
  const isAll = mode === "all";
  root.innerHTML = `<div class="page"><div class="spinner"></div></div>`;

  let tickets, unassigned = [], users = [];
  try {
    if (isAll) {
      [tickets, users] = await Promise.all([
        api.get(`/all-tickets${allAssignee ? `?assigneeId=${encodeURIComponent(allAssignee)}` : ""}`),
        api.get("/admin/users"),
      ]);
    } else {
      [tickets, unassigned] = await Promise.all([api.get("/my-tickets"), api.get("/my-tickets/unassigned")]);
    }
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }

  const rerender = () => renderTickets(root, mode);
  const known = new Set([...tickets, ...unassigned].map((t) => t.id));
  for (const id of [...selectedIds]) if (!known.has(id)) selectedIds.delete(id);

  const groupBy = (list) => {
    const groups = new Map();
    for (const t of list) {
      if (!groups.has(t.projectId)) {
        groups.set(t.projectId, { name: t.projectName, prefix: t.projectPrefix, tasks: [] });
      }
      groups.get(t.projectId).tasks.push(t);
    }
    return groups;
  };
  const groups = groupBy(tickets);
  const unassignedGroups = groupBy(unassigned);

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h1>${isAll ? "All Tickets" : "My Tickets"}</h1>
        <span class="mt-total">${tickets.length} ${isAll ? "ticket" + (tickets.length === 1 ? "" : "s") : "assigned to you"}</span>
        ${isAll ? `<select id="all-assignee" aria-label="Filter by assignee">
          <option value="">All assignees</option>
          <option value="none"${allAssignee === "none" ? " selected" : ""}>Unassigned</option>
          ${users.map((x) => `<option value="${esc(x.id)}"${allAssignee === x.id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}
        </select>` : ""}
        <div class="btn-group view-toggle" role="group" aria-label="View" style="margin-left:auto">
          <button class="btn sm ${viewMode === "board" ? "" : "ghost"}" id="view-board-btn">Board</button>
          <button class="btn sm ${viewMode === "list" ? "" : "ghost"}" id="view-list-btn">List</button>
        </div>
      </div>
      ${groups.size === 0
        ? `<div class="empty-note">${isAll ? "No tickets match this filter." : "No tickets are assigned to you. Assigned tickets from every project will show up here."}</div>`
        : [...groups.entries()].map(([projectId, g]) => projectSection(projectId, g)).join("")}
      ${isAll ? "" : `
        <div class="page-head" style="margin-top:28px">
          <h1>Unassigned</h1>
          <span class="mt-total">${unassigned.length} without an assignee</span>
        </div>
        ${unassignedGroups.size === 0
          ? `<div class="empty-note">No unassigned tickets in projects you can view.</div>`
          : [...unassignedGroups.entries()].map(([projectId, g]) => projectSection(projectId, g)).join("")}`}
      <div class="bulk-bar hidden" id="bulk-bar"></div>
    </div>`;

  root.querySelector("#view-board-btn").addEventListener("click", () => { if (viewMode !== "board") { viewMode = "board"; localStorage.setItem("tm-ticket-view", "board"); rerender(); } });
  root.querySelector("#view-list-btn").addEventListener("click", () => { if (viewMode !== "list") { viewMode = "list"; localStorage.setItem("tm-ticket-view", "list"); rerender(); } });
  root.querySelector("#all-assignee")?.addEventListener("change", (e) => { allAssignee = e.target.value; rerender(); });

  bindRows(root, rerender);
  renderBulkBar(root, rerender);
}

function bindRows(root, rerender) {
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
      renderBulkBar(root, rerender);
    });
  }
}

function renderBulkBar(root, rerender) {
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
    <button class="btn sm danger" id="bulk-delete">Delete…</button>
    <button class="btn sm ghost" id="bulk-clear">Clear selection</button>`;

  bar.querySelector("#bulk-delete").addEventListener("click", async () => {
    const list = [...root.querySelectorAll(".mt-card, .list-row")]
      .filter((el) => selectedIds.has(el.dataset.id))
      .map((el) => ({ id: el.dataset.id, ticketId: el.querySelector(".ticket-id")?.textContent || el.dataset.id }));
    const deleted = await bulkDeleteTickets(list);
    if (!deleted) return;
    selectedIds = new Set();
    await rerender();
  });

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
      await rerender();
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
    rerender();
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
