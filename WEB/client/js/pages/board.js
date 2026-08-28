import { api } from "../api.js";
import { navigate, requireAuth, state } from "../main.js";
import {
  STATUSES, getStatusColor, STATUS_LABELS, canTransition,
  esc, avatarHtml, statusPill, openModal, toast, fmtDate,
  sanitizeDesc, descToEditorHtml, isEmptyDesc,
  TASK_TYPES, TYPE_LABELS, PRIORITIES, PRIORITY_LABELS, priorityPill, branchName,
} from "../ui.js";

let project = null;
let myRole = "MEMBER";
let tasks = [];
let filterText = "";
let filterAssignee = "";
let filterSprint = "";
let collapsedLanes = new Set();
let boardStream = null;
let refreshTimer = null;

// Live updates: one EventSource per board; closed on navigation.
function openBoardStream(projectId) {
  closeBoardStream();
  boardStream = new EventSource(`/api/projects/${projectId}/stream`);
  boardStream.addEventListener("ticket-changed", () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      // Don't fight an in-progress drag; the next event or refresh catches up.
      if (document.querySelector(".card.dragging")) return;
      try {
        tasks = await api.get(`/projects/${projectId}/tasks`);
        refreshColumns();
      } catch { /* transient; next event or refresh recovers */ }
    }, 150);
  });
}

export function closeBoardStream() {
  clearTimeout(refreshTimer);
  if (boardStream) {
    boardStream.close();
    boardStream = null;
  }
}

export async function renderBoard(root, projectId, initialSprint = "", initialTaskId = "") {
  if (!requireAuth(`/projects/${projectId}`)) return;
  root.innerHTML = `<div class="spinner"></div>`;

  try {
    [project, tasks] = await Promise.all([
      api.get(`/projects/${projectId}`),
      api.get(`/projects/${projectId}/tasks`),
    ]);
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }

  const isSuper = state.user.role === "SUPER_ADMIN";
  const cachedProj = Array.isArray(state.projectsCache)
    ? state.projectsCache.find((p) => p.id === projectId) : null;
  myRole = isSuper || cachedProj?.role === "ADMIN" ? "ADMIN" : "MEMBER";

  // Each sprint gets its own swim lane. A deep-link (?sprint=<id>) auto-expands
  // only that lane and collapses the rest; otherwise all lanes are expanded.
  filterText = "";
  filterAssignee = "";
  collapsedLanes = new Set();
  if (initialSprint && (initialSprint === "backlog" || project.sprints.some((s) => s.id === initialSprint))) {
    for (const s of project.sprints) {
      if (s.id !== initialSprint) collapsedLanes.add(s.id);
    }
    if (initialSprint !== "backlog") collapsedLanes.add("backlog");
  }

  drawShell(root);

  if (initialTaskId) {
    const t = tasks.find((x) => x.id === initialTaskId || x.ticketId === initialTaskId);
    if (t) requestAnimationFrame(() => taskModal(t));
  }
}

async function renderMembers(root, projectId) {
  if (!requireAuth(`/projects/${projectId}/members`)) return;
  try {
    project = await api.get(`/projects/${projectId}`);
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }
  const isSuper = state.user.role === "SUPER_ADMIN";
  const cachedProj = Array.isArray(state.projectsCache)
    ? state.projectsCache.find((p) => p.id === projectId) : null;
  myRole = isSuper || cachedProj?.role === "ADMIN" ? "ADMIN" : "MEMBER";

  root.innerHTML = `
    ${headHtml("members")}
    <div class="page" style="max-width:860px">
      ${myRole === "ADMIN" ? `
      <div class="hint-card">
        <span>You are a project admin. Manage settings, invitations and deletion from the <strong>Admin Panel</strong>.</span>
        <a class="btn sm ghost" href="/admin/users" data-nav>Open Admin Panel</a>
      </div>` : ""}
      <div class="table-card">
        <table class="data">
          <thead><tr><th>Name</th><th>E-mail</th><th>Project role</th></tr></thead>
          <tbody>
            ${project.members.map((m) => `
              <tr>
                <td style="display:flex;align-items:center;gap:10px">${avatarHtml(m.name, m.userId)} ${esc(m.name)}</td>
                <td>${esc(m.email)}</td>
                <td>${m.role === "ADMIN"
                  ? `<span class="role-chip role-admin">ADMIN</span>`
                  : `<span class="role-chip role-member">MEMBER</span>`}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
  bindTabs();
}
export { renderMembers as renderMembersTab };

/* ---------------- Sprints tab ---------------- */

let sprintsRoot = null;

function nextSprintPreview() {
  let max = 0;
  for (const s of project.sprints) {
    const m = /-S(\d+)$/.exec(s.sprintId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${project.prefix}-S${max + 1}`;
}

async function renderSprintsTab(root, projectId) {
  if (!requireAuth(`/projects/${projectId}/sprints`)) return;
  root.innerHTML = `<div class="spinner"></div>`;

  let proj;
  try {
    proj = await api.get(`/projects/${projectId}`);
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }
  project = proj;
  const isSuper = state.user.role === "SUPER_ADMIN";
  const cachedProj = Array.isArray(state.projectsCache)
    ? state.projectsCache.find((p) => p.id === projectId) : null;
  myRole = isSuper || cachedProj?.role === "ADMIN" ? "ADMIN" : "MEMBER";

  drawSprints(root);
}
export { renderSprintsTab as renderSprintsTab };

function drawSprints(root) {
  sprintsRoot = root;
  const canManage = myRole === "ADMIN";
  root.innerHTML = `
    ${headHtml("sprints")}
    <div class="page" style="max-width:920px">
      ${canManage ? `
      <div class="hint-card">
        <span>Every project keeps at least one sprint. Add iterations and delete the ones you no longer need — tickets are never removed, they simply become unsprinted.</span>
      </div>` : ""}
      <div class="table-card">
        <table class="data">
          <thead><tr><th>Sprint ID</th><th>Name</th><th>Tickets</th>${canManage ? "<th></th>" : ""}</tr></thead>
          <tbody>
            ${project.sprints.map((s) => sprintRow(s, canManage)).join("")}
          </tbody>
        </table>
      </div>
      ${canManage ? `<div class="modal-actions" style="margin-top:14px"><button class="btn sm" id="add-sprint-btn">+ New sprint</button></div>` : ""}
    </div>`;

  bindTabs();
  if (!canManage) return;

  root.querySelector("#add-sprint-btn").addEventListener("click", () => openSprintModal(null));
  for (const btn of root.querySelectorAll("[data-rename]")) {
    btn.addEventListener("click", () => {
      const s = project.sprints.find((x) => x.id === btn.getAttribute("data-rename"));
      if (s) openSprintModal(s);
    });
  }
  for (const btn of root.querySelectorAll("[data-delete]")) {
    btn.addEventListener("click", async () => {
      const sid = btn.getAttribute("data-delete");
      const s = project.sprints.find((x) => x.id === sid);
      if (!s) return;
      if (!confirm(`Delete sprint ${s.sprintId} (${s.name})? Its ${Number(s.ticketCount ?? 0)} ticket(s) will be kept but removed from this sprint.`)) return;
      btn.disabled = true;
      try {
        await api.del(`/projects/${project.id}/sprints/${sid}`);
        toast(`${s.sprintId} deleted`, "ok");
        project = await api.get(`/projects/${project.id}`);
        drawSprints(sprintsRoot);
      } catch (err) {
        toast(err.message, "err");
        btn.disabled = false;
      }
    });
  }
}

function sprintRow(s, canManage) {
  return `
    <tr>
      <td><span class="ticket-id">${esc(s.sprintId)}</span></td>
      <td>${esc(s.name)}</td>
      <td>${Number(s.ticketCount ?? 0)}</td>
      <td style="text-align:right">
        <a class="btn sm ghost" href="/projects/${encodeURIComponent(project.id)}?sprint=${encodeURIComponent(s.id)}" data-nav>Open board</a>
        ${canManage ? `<button class="btn ghost sm" data-rename="${esc(s.id)}">Rename</button>
        <button class="btn danger sm" data-delete="${esc(s.id)}">Delete</button>` : ""}
      </td>
    </tr>`;
}

function openSprintModal(existing) {
  const isEdit = Boolean(existing);
  openModal({
    title: isEdit ? "Rename sprint" : "New sprint",
    body: `
      <div class="field">
        <label for="sp-name">Name</label>
        <input type="text" id="sp-name" placeholder="e.g. Sprint 2" value="${isEdit ? esc(existing.name) : ""}" />
        ${isEdit
          ? `<div style="color:var(--text-dim);font-size:12px;margin-top:4px">ID <span class="ticket-id">${esc(existing.sprintId)}</span> cannot be changed.</div>`
          : `<div style="color:var(--text-dim);font-size:12px;margin-top:4px">ID is assigned automatically (<span class="ticket-id">${esc(nextSprintPreview())}</span>).</div>`}
      </div>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="sp-cancel">Cancel</button>
          <button class="btn" id="sp-save">${isEdit ? "Save" : "Create"}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      modalEl.querySelector("#sp-cancel").addEventListener("click", close);
      const save = modalEl.querySelector("#sp-save");
      save.addEventListener("click", async () => {
        const name = modalEl.querySelector("#sp-name").value.trim();
        if (!name) { toast("Name is required", "err"); return; }
        save.disabled = true;
        try {
          if (isEdit) {
            await api.patch(`/projects/${project.id}/sprints/${existing.id}`, { name });
            toast("Sprint renamed", "ok");
          } else {
            await api.post(`/projects/${project.id}/sprints`, { name });
            toast("Sprint created", "ok");
          }
          close();
          project = await api.get(`/projects/${project.id}`);
          drawSprints(sprintsRoot);
        } catch (err) {
          toast(err.message, "err");
          save.disabled = false;
        }
      });
    },
  });
}

/* ---------------- Shell ---------------- */

function headHtml(activeTab) {
  return `
    <div class="proj-head">
      <div class="proj-title-row">
        <h1>${esc(project.name)}</h1>
        <span class="prefix-chip">${esc(project.prefix)}</span>
        ${myRole === "ADMIN" ? `<span class="role-chip role-admin">You are admin</span>` : ""}
      </div>
      <nav class="tabs">
        <button class="tab ${activeTab === "board" ? "active" : ""}" data-tab="board">Board (${tasks.length})</button>
        <button class="tab ${activeTab === "members" ? "active" : ""}" data-tab="members">Members (${project.members.length})</button>
        <button class="tab ${activeTab === "sprints" ? "active" : ""}" data-tab="sprints">Sprints (${project.sprints.length})</button>
      </nav>
    </div>`;
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      const base = `/projects/${project.id}`;
      navigate(tab === "members" ? `${base}/members` : tab === "sprints" ? `${base}/sprints` : base);
    });
  });
}

function drawShell(root) {
  root.innerHTML = `
    ${headHtml("board")}
    <div class="toolbar">
      <input type="text" class="search" id="filter-text" placeholder="Search tickets..." value="${esc(filterText)}" />
      <select id="filter-assignee">
        <option value="">All assignees</option>
        ${project.members.map((m) => `<option value="${esc(m.userId)}">${esc(m.name)}</option>`).join("")}
      </select>
      <div class="btn-group">
        <button class="btn sm ghost" id="export-btn">Export JSON</button>
        <button class="btn sm" id="new-task-btn">+ New ticket</button>
      </div>
    </div>
    <div class="board-scroll">
      <div class="board">
        ${project.sprints.map((s) => laneHtml(s)).join("")}
        ${backlogLaneHtml()}
      </div>
    </div>`;

  bindTabs();
  document.getElementById("new-task-btn").addEventListener("click", () => taskModal(null));
  document.getElementById("export-btn").addEventListener("click", async () => {
    try {
      const data = await api.get(`/projects/${encodeURIComponent(project.id)}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.prefix}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(err.message || "Export failed", "error");
    }
  });
  openBoardStream(project.id);

  const searchEl = document.getElementById("filter-text");
  searchEl.addEventListener("input", () => { filterText = searchEl.value.toLowerCase(); refreshColumns(); });

  const assigneeEl = document.getElementById("filter-assignee");
  assigneeEl.value = filterAssignee;
  assigneeEl.addEventListener("change", () => { filterAssignee = assigneeEl.value; refreshColumns(); });

  // Lane collapse toggles
  root.querySelectorAll(".sprint-lane-head").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const id = head.dataset.toggle;
      if (collapsedLanes.has(id)) collapsedLanes.delete(id);
      else collapsedLanes.add(id);
      drawShell(root);
    });
  });

  // "+ Create" inside each lane column
  root.querySelectorAll(".col-add").forEach((btn) =>
    btn.addEventListener("click", () => taskModal(null, btn.dataset.add, btn.dataset.lane || ""))
  );

  bindDragAndDrop();
  refreshColumns();
}

/* ---------- Swim-lane helpers ---------- */

function laneHtml(sprint) {
  const collapsed = collapsedLanes.has(sprint.id);
  return `
    <section class="sprint-lane${collapsed ? " collapsed" : ""}" data-lane="${esc(sprint.id)}">
      <div class="sprint-lane-head" data-toggle="${esc(sprint.id)}">
        <span class="lane-arrow">${collapsed ? "\u25B6" : "\u25BC"}</span>
        <span class="ticket-id lane-id">${esc(sprint.sprintId)}</span>
        <span class="lane-name">${esc(sprint.name)}</span>
        <span class="lane-count">${Number(sprint.ticketCount ?? 0)} work items</span>
      </div>
      ${collapsed ? "" : `<div class="lane-columns">${STATUSES.map((s) => laneColumnHtml(sprint.id, s)).join("")}</div>`}
    </section>`;
}

function backlogLaneHtml() {
  const count = tasks.filter((t) => !t.sprintId).length;
  const collapsed = collapsedLanes.has("backlog");
  return `
    <section class="sprint-lane backlog-lane${collapsed ? " collapsed" : ""}" data-lane="backlog">
      <div class="sprint-lane-head" data-toggle="backlog">
        <span class="lane-arrow">${collapsed ? "\u25B6" : "\u25BC"}</span>
        <span class="lane-name">Everything else</span>
        <span class="lane-count">${count} work items</span>
      </div>
      ${collapsed ? "" : `<div class="lane-columns">${STATUSES.map((s) => laneColumnHtml("backlog", s)).join("")}</div>`}
    </section>`;
}

function laneColumnHtml(laneId, status) {
  return `
    <section class="column" data-lane="${esc(laneId)}" data-status="${status}">
      <header class="col-head">
        <span class="col-dot" style="background:${getStatusColor(status)}"></span>
        <span class="col-label">${STATUS_LABELS[status]}</span>
        <span class="col-count" data-count>0</span>
        <button class="col-add" data-add="${status}" data-lane="${esc(laneId)}" title="Add ticket here">+</button>
      </header>
      <div class="col-body" data-body="${status}"></div>
    </section>`;
}

function cardHtml(t) {
  const assignee = memberById(t.assigneeId);
  const movable = canModifyTask(t);
  return `
    <article class="card ${movable ? "" : "locked"}" draggable="${movable}" data-id="${esc(t.id)}">
      <div class="row">
        <span class="ticket-id">${esc(t.ticketId)}</span>
        <span class="card-meta">
          ${priorityPill(t.priority)}
          <span class="assignee">
            ${assignee
              ? `${avatarHtml(assignee.name, assignee.userId)}<span class="nm">${esc(assignee.name.split(" ")[0])}</span>`
              : `<span class="nm">Unassigned</span>`}
          </span>
        </span>
      </div>
      <p class="title">${esc(t.title)}</p>
    </article>`;
}

function memberById(id) {
  return project.members.find((m) => m.userId === id) || null;
}

function canModifyTask(t) {
  if (myRole === "ADMIN") return true;
  return t.assigneeId === state.user.id || t.createdBy === state.user.id;
}

function visibleTasks(status, laneId) {
  return tasks
    .filter((t) => t.status === status)
    .filter((t) => {
      if (laneId === "backlog") return !t.sprintId;
      return t.sprintId === laneId;
    })
    .filter((t) => !filterText ||
      t.title.toLowerCase().includes(filterText) ||
      t.ticketId.toLowerCase().includes(filterText))
    .filter((t) => !filterAssignee || t.assigneeId === filterAssignee)
    .sort((a, b) => a.position - b.position);
}

function refreshColumns() {
  document.querySelectorAll(".column").forEach((col) => {
    const status = col.dataset.status;
    const laneId = col.dataset.lane;
    const body = col.querySelector("[data-body]");
    body.innerHTML = "";
    const list = visibleTasks(status, laneId);
    if (list.length === 0) {
      body.innerHTML = `<div class="col-empty">No tickets</div>`;
    } else {
      for (const t of list) {
        body.insertAdjacentHTML("beforeend", cardHtml(t));
      }
    }
    col.querySelector("[data-count]").textContent = String(list.length);
  });

  document.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => card.classList.add("dragging"));
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      clearDropMarkers();
    });
    card.addEventListener("click", () => {
      const t = tasks.find((x) => x.id === card.dataset.id);
      if (t) taskModal(t);
    });
  });
}

/* ---------------- Drag & drop ---------------- */

function clearDropMarkers() {
  document.querySelectorAll(".column").forEach((c) => c.classList.remove("drop-ok", "drop-bad"));
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
}

function insertionIndex(body, clientY, draggedId) {
  const cards = [...body.querySelectorAll(".card")].filter((c) => c.dataset.id !== draggedId);
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return { idx: i, beforeTaskId: cards[i].dataset.id };
  }
  return { idx: cards.length, beforeTaskId: null };
}

function showIndicator(body, idx, ok) {
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
  const ind = document.createElement("div");
  ind.className = "drop-indicator";
  ind.style.background = ok ? "var(--accent)" : "var(--danger)";
  const empty = body.querySelector(".col-empty");
  if (!empty && body.children.length === 0) {
    body.appendChild(ind);
    return;
  }
  if (idx >= body.children.length || (empty && body.children.length === 1)) {
    body.appendChild(ind);
  } else {
    body.insertBefore(ind, body.children[idx]);
  }
}

function bindDragAndDrop() {
  document.querySelectorAll(".column").forEach((col) => {
    const status = col.dataset.status;
    const laneId = col.dataset.lane;
    const body = col.querySelector("[data-body]");
    let lastOk = false;

    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
      const draggedId = e.dataTransfer.types.includes("text/plain") ? draggingId : null;
      if (!draggedId) return;
      const dragged = tasks.find((t) => t.id === draggedId);
      if (!dragged) return;

      const sameColumn = dragged.status === status;
      const legal = sameColumn || canTransition(dragged.status, status);
      lastOk = legal;
      e.dataTransfer.dropEffect = legal ? "move" : "none";
      col.classList.toggle("drop-ok", legal);
      col.classList.toggle("drop-bad", !legal);
      const { idx } = insertionIndex(body, e.clientY, draggedId);
      showIndicator(body, idx, legal);
    });

    col.addEventListener("dragleave", (e) => {
      if (!col.contains(e.relatedTarget)) {
        col.classList.remove("drop-ok", "drop-bad");
      }
    });

    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      clearDropMarkers();
      const draggedId = e.dataTransfer.getData("text/plain");
      const dragged = tasks.find((t) => t.id === draggedId);
      if (!dragged) return;

      const { beforeTaskId } = insertionIndex(body, e.clientY, draggedId);
      const sameColumn = dragged.status === status;
      if (!sameColumn && !canTransition(dragged.status, status)) {
        toast(`Illegal move: ${STATUS_LABELS[dragged.status]} \u2192 ${STATUS_LABELS[status]}`, "err");
        return;
      }

      // Determine new sprint: moving across lanes changes the sprint assignment.
      const newSprintId = laneId === "backlog" ? null : laneId;
      const sprintChanged = dragged.sprintId !== newSprintId;

      if (sameColumn && !sprintChanged && sameColumnOrderUnchanged(dragged, status, beforeTaskId, laneId)) return;

      await moveTask(dragged, status, beforeTaskId, newSprintId);
    });
  });
}

function sameColumnOrderUnchanged(task, status, beforeTaskId, laneId) {
  if (task.status !== status) return false;
  const ordered = visibleTasks(status, laneId);
  const rest = ordered.filter((t) => t.id !== task.id);
  const at = beforeTaskId ? rest.findIndex((t) => t.id === beforeTaskId) : rest.length;
  const next = [...rest.slice(0, at), task, ...rest.slice(at)];
  return next.map((t) => t.id).join("|") === ordered.map((t) => t.id).join("|");
}

async function moveTask(task, newStatus, beforeTaskId, newSprintId) {
  const oldStatus = task.status;
  const oldSprintId = task.sprintId;
  // Optimistic local reorder
  removeLocal(task.id);
  const siblings = tasks
    .filter((t) => t.status === newStatus)
    .sort((a, b) => a.position - b.position);
  task.status = newStatus;
  task.sprintId = newSprintId ?? oldSprintId;
  task.position = beforeTaskId
    ? localNeighborPosition(siblings, beforeTaskId)
    : (siblings.at(-1)?.position ?? 0) + 1;
  tasks.push(task);

  const payload = { status: newStatus, beforeTaskId: beforeTaskId || undefined };
  if (newSprintId !== undefined && newSprintId !== oldSprintId) {
    payload.sprintId = newSprintId;
  }

  try {
    const updated = await api.patch(`/projects/${project.id}/tasks/${task.id}`, payload);
    Object.assign(task, updated);
    if (oldStatus !== newStatus) {
      toast(`${task.ticketId} moved to ${STATUS_LABELS[newStatus]}`, "ok");
    }
    if (oldSprintId !== task.sprintId) {
      const label = task.sprintId
        ? project.sprints.find((s) => s.id === task.sprintId)?.sprintId ?? "sprint"
        : "backlog";
      toast(`${task.ticketId} moved to ${label}`, "ok");
    }
  } catch (err) {
    toast(err.message, "err");
    task.status = oldStatus;
    task.sprintId = oldSprintId;
    try {
      tasks = await api.get(`/projects/${project.id}/tasks`);
    } catch { /* keep optimistic state */ }
  }
  refreshColumns();
}

function localNeighborPosition(siblings, beforeTaskId) {
  const idx = siblings.findIndex((t) => t.id === beforeTaskId);
  if (idx === -1) return (siblings.at(-1)?.position ?? 0) + 1;
  const prev = siblings[idx - 1]?.position ?? siblings[0].position - 1;
  return (prev + siblings[idx].position) / 2;
}

function removeLocal(id) {
  tasks = tasks.filter((t) => t.id !== id);
}

// Track dragged card id (dataTransfer.types is all we get during dragover)
document.addEventListener("dragstart", (e) => {
  if (e.target.classList?.contains("card")) draggingId = e.target.dataset.id;
});
let draggingId = null;

/* ---------------- Task modal ---------------- */

function assigneeOptions(selectedId) {
  return [`<option value="">Unassigned</option>`]
    .concat(project.members.map((m) =>
      `<option value="${esc(m.userId)}" ${m.userId === selectedId ? "selected" : ""}>${esc(m.name)}</option>`))
    .join("");
}

function taskModal(task, presetStatus = "TODO", presetSprintId = "") {
  const isEdit = Boolean(task);
  const mayEdit = !isEdit || canModifyTask(task);
  const dis = mayEdit ? "" : "disabled";
  const creator = isEdit ? memberById(task.createdBy) : null;

  openModal({
    wide: true,
    title: !isEdit
      ? `New ticket`
      : `<span class="ticket-id">${esc(task.ticketId)}</span> ${mayEdit ? "Edit ticket" : "Ticket details"}`,
    body: `
      <div id="task-error" class="form-error hidden"></div>
      <form id="task-form">
        <div class="task-grid">
          <div class="task-left">
            <div class="field">
              <label for="tf-title">Title</label>
              <input id="tf-title" type="text" required ${dis} value="${isEdit ? esc(task.title) : ""}" />
            </div>
            <div class="field">
              <label for="tf-desc">Description</label>
              ${mayEdit ? `
              <div class="rte-toolbar" id="tf-desc-toolbar">
                <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
                <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
                <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
                <button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
                <span class="rte-sep"></span>
                <button type="button" data-block="h2" title="Heading">H2</button>
                <button type="button" data-block="h3" title="Subheading">H3</button>
                <button type="button" data-block="p" title="Paragraph">&para;</button>
                <span class="rte-sep"></span>
                <button type="button" data-cmd="insertUnorderedList" title="Bullet list">&bull; &#8801;</button>
                <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. &#8801;</button>
                <span class="rte-sep"></span>
                <button type="button" id="tf-link" title="Insert link">&#128279;</button>
                <button type="button" id="tf-code" title="Code block">&lt;/&gt;</button>
                <button type="button" id="tf-image" title="Insert image">&#128444;</button>
                <button type="button" id="tf-video" title="Insert video">&#127916;</button>
                <span class="rte-sep"></span>
                <button type="button" data-cmd="removeFormat" title="Clear formatting">&#10539;</button>
              </div>` : ""}
              <input type="file" id="tf-media-input" hidden />
              <div id="tf-desc" class="rte" contenteditable="${mayEdit}" aria-label="Description">${descToEditorHtml(isEdit ? task.description : "")}</div>
            </div>
            <div class="modal-actions">
              ${isEdit && mayEdit && myRole === "ADMIN" ? `<button type="button" class="btn danger" id="tf-delete">Delete</button>` : ""}
              ${!mayEdit ? `<span class="ro-note">Read-only &mdash; only the assignee, the ticket creator or a project admin can modify this ticket.</span>` : ""}
              <span id="tf-savestate" class="save-state"></span>
              <span class="right">
                ${mayEdit ? `<button type="submit" class="btn" id="tf-save">${isEdit ? "Save" : "Create ticket"}</button>` : ""}
                <button type="button" class="btn ghost" data-close>${isEdit ? "Close" : "Cancel"}</button>
              </span>
            </div>
            ${isEdit ? `
            <div class="comments-block">
              <div class="activity-head">Comments</div>
              <div class="comment-box">
                <div class="comment-rte-wrap">
                  <div class="rte-toolbar" id="tf-comment-toolbar">
                    <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
                    <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
                    <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
                    <button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
                    <span class="rte-sep"></span>
                    <button type="button" data-block="h2" title="Heading">H2</button>
                    <button type="button" data-block="h3" title="Subheading">H3</button>
                    <button type="button" data-block="p" title="Paragraph">&para;</button>
                    <span class="rte-sep"></span>
                    <button type="button" data-cmd="insertUnorderedList" title="Bullet list">&bull; &#8801;</button>
                    <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. &#8801;</button>
                    <span class="rte-sep"></span>
                    <button type="button" id="tf-comment-link" title="Insert link">&#128279;</button>
                    <button type="button" id="tf-comment-code" title="Code block">&lt;/&gt;</button>
                    <button type="button" id="tf-comment-image" title="Insert image">&#128444;</button>
                    <button type="button" id="tf-comment-video" title="Insert video">&#127916;</button>
                    <span class="rte-sep"></span>
                    <button type="button" data-cmd="removeFormat" title="Clear formatting">&#10539;</button>
                  </div>
                  <input type="file" id="tf-comment-media-input" hidden />
                  <div id="tf-comment-input" class="rte comment-rte" contenteditable="true" data-placeholder="Write a comment&hellip; type @ to mention someone (Ctrl+Enter to send)"></div>
                </div>
                <button type="button" class="btn sm" id="tf-comment-send">Send</button>
                <div id="tf-mention-menu" class="mention-menu hidden"></div>
              </div>
              <ol id="tf-comments" class="comment-list"><li class="act-empty">Loading&hellip;</li></ol>
            </div>` : ""}
          </div>
          <div class="task-right">
            <div class="detail-card">
              <div class="detail-row">
                <span class="k">Project</span>
                <span class="v">${esc(project.name)}&nbsp;<span class="prefix-chip">${esc(project.prefix)}</span></span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">Ticket ID</span>
                <span class="v"><span class="ticket-id">${esc(task.ticketId)}</span></span>
              </div>` : ""}
              <div class="detail-row">
                <span class="k">Type${isEdit && myRole !== "ADMIN" ? " (admin only)" : ""}</span>
                <span class="v">
                  <select id="tf-type" ${!isEdit || myRole === "ADMIN" ? dis : "disabled"}>
                    ${TASK_TYPES.map((v) => `<option value="${v}" ${v === (isEdit ? task.type : "TASK") ? "selected" : ""}>${TYPE_LABELS[v]}</option>`).join("")}
                  </select>
                </span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">Branch</span>
                <span class="v"><code class="branch-chip" id="tf-branch" title="Click to copy">${esc(branchName(task))}</code></span>
              </div>` : ""}
              <div class="detail-row">
                <span class="k">Priority${isEdit && myRole !== "ADMIN" ? " (admin only)" : ""}</span>
                <span class="v">
                  <select id="tf-priority" ${!isEdit || myRole === "ADMIN" ? dis : "disabled"}>
                    ${PRIORITIES.map((v) => `<option value="${v}" ${v === (isEdit ? task.priority : "MEDIUM") ? "selected" : ""}>${PRIORITY_LABELS[v]}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">Status</span>
                <span class="v">
                  <select id="tf-status" ${dis}>
                    ${(isEdit ? allowedTargetList(task.status) : STATUSES.map((s) => ({ value: s }))).map(({ value, label }) =>
                      `<option value="${esc(value)}" ${value === (isEdit ? task.status : presetStatus) ? "selected" : ""}>${esc(label || STATUS_LABELS[value])}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">Sprint</span>
                <span class="v">
                  <select id="tf-sprint" ${dis}>
                    <option value="">Backlog (no sprint)</option>
                    ${project.sprints.map((s) => `<option value="${esc(s.id)}" ${(isEdit ? task.sprintId : presetSprintId) === s.id ? "selected" : ""}>${esc(s.sprintId)} &mdash; ${esc(s.name)}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">Assignee${isEdit && mayEdit && myRole !== "ADMIN" ? " (admin only)" : ""}</span>
                <span class="v">
                  <select id="tf-assignee" ${mayEdit && (myRole === "ADMIN" || !isEdit) ? "" : "disabled"}>${assigneeOptions(isEdit ? task.assigneeId : "")}</select>
                </span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">Created by</span>
                <span class="v">${creator ? `${avatarHtml(creator.name, creator.userId)} ${esc(creator.name)}` : "&mdash;"}</span>
              </div>
              <div class="detail-row">
                <span class="k">Created</span>
                <span class="v">${fmtDate(task.createdAt)}</span>
              </div>
              <div class="detail-row">
                <span class="k">Updated</span>
                <span class="v">${fmtDate(task.updatedAt)}</span>
              </div>` : ""}
            </div>
            ${isEdit ? `
            <div class="detail-card activity-card">
              <div class="activity-head">Activity</div>
              <ol id="tf-activity" class="activity-list"><li class="act-empty">Loading&hellip;</li></ol>
            </div>` : ""}
          </div>
        </div>
      </form>`,
    onMount(modalEl, close) {
      modalEl.querySelector("[data-close]").addEventListener("click", close);
      const errBox = modalEl.querySelector("#task-error");
      const form = modalEl.querySelector("#task-form");

      // ---- Auto-save ----
      // Every field change persists immediately. In create mode the ticket is
      // created automatically once a title exists; before that, edits are
      // remembered in `pendingDraft` and flushed on creation.
      let saveChain = Promise.resolve();
      let created = isEdit;
      let taskRef = task;
      const pendingDraft = {};
      const saveStateEl = modalEl.querySelector("#tf-savestate");
      function setSaveState(s, msg = "") {
        if (!saveStateEl) return;
        saveStateEl.className = `save-state ${s}`;
        saveStateEl.textContent =
          s === "saving" ? "Saving…" :
          s === "saved" ? "All changes saved" :
          s === "error" ? (msg || "Couldn’t save — check your connection") :
          s === "draft" ? "Start typing a title to create the ticket" : "";
      }
      const debounce = (fn, ms) => {
        let t;
        return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
      };
      function commit(patch) {
        saveChain = saveChain.then(() => doCommit(patch)).catch(() => {});
        return saveChain;
      }
      async function doCommit(patch) {
        if (created) {
          setSaveState("saving");
          const updated = await api.patch(`/projects/${project.id}/tasks/${taskRef.id}`, patch);
          Object.assign(taskRef, updated);
          setSaveState("saved");
          refreshColumns();
        } else {
          Object.assign(pendingDraft, patch);
          if (pendingDraft.title && pendingDraft.title.trim()) {
            setSaveState("saving");
            await flushCreate();
          } else {
            setSaveState("draft");
          }
        }
      }
      async function flushCreate() {
        const payload = {
          title: pendingDraft.title.trim(),
          description: pendingDraft.description ?? "",
          status: pendingDraft.status || presetStatus,
          sprintId: pendingDraft.sprintId ?? (presetSprintId || null),
          type: pendingDraft.type || "TASK",
          priority: pendingDraft.priority || "MEDIUM",
          assigneeId: pendingDraft.assigneeId || null,
        };
        const createdTask = await api.post(`/projects/${project.id}/tasks`, payload);
        created = true;
        taskRef = createdTask;
        tasks.push(createdTask);
        const h = modalEl.querySelector(".modal-head h2");
        if (h) h.innerHTML = `<span class="ticket-id">${esc(createdTask.ticketId)}</span> Edit ticket`;
        setSaveState("saved");
        refreshColumns();
        toast(`${createdTask.ticketId} created`, "ok");
      }
      if (!isEdit) setSaveState("draft");

      // Full, explicit save of every field (manual "backup" button).
      async function fullSave() {
        const descHtml = sanitizeDesc(form.querySelector("#tf-desc").innerHTML);
        const payload = {
          title: form.querySelector("#tf-title").value.trim(),
          description: isEmptyDesc(descHtml) ? "" : descHtml,
        };
        if (myRole === "ADMIN" || !isEdit) {
          payload.assigneeId = form.querySelector("#tf-assignee").value || null;
          payload.type = form.querySelector("#tf-type").value;
          payload.priority = form.querySelector("#tf-priority").value;
        }
        const sprintVal = form.querySelector("#tf-sprint").value;
        payload.sprintId = sprintVal || null;
        if (isEdit) payload.status = form.querySelector("#tf-status").value;

        if (created) {
          setSaveState("saving");
          const updated = await api.patch(`/projects/${project.id}/tasks/${taskRef.id}`, payload);
          Object.assign(taskRef, updated);
          setSaveState("saved");
          refreshColumns();
          toast(`${taskRef.ticketId} saved`, "ok");
        } else {
          if (!payload.title) {
            setSaveState("draft");
            form.querySelector("#tf-title").focus();
            return;
          }
          setSaveState("saving");
          const createdTask = await api.post(`/projects/${project.id}/tasks`, payload);
          created = true;
          taskRef = createdTask;
          tasks.push(createdTask);
          const h = modalEl.querySelector(".modal-head h2");
          if (h) h.innerHTML = `<span class="ticket-id">${esc(createdTask.ticketId)}</span> Edit ticket`;
          setSaveState("saved");
          refreshColumns();
          toast(`${createdTask.ticketId} created`, "ok");
        }
      }

      const actList = modalEl.querySelector("#tf-activity");
      if (actList) loadActivity(actList, task.id);
      const cmtList = modalEl.querySelector("#tf-comments");
      if (cmtList) setupComments(modalEl, cmtList, task.id);

      // Branch name follows the selected type; click to copy.
      const typeSel = modalEl.querySelector("#tf-type");
      const branchChip = modalEl.querySelector("#tf-branch");
      if (typeSel && branchChip) {
        typeSel.addEventListener("change", () => {
          branchChip.textContent = `${typeSel.value === "BUG" ? "hotfix" : "feature"}/${task.ticketId}`;
        });
        branchChip.addEventListener("click", () => {
          navigator.clipboard?.writeText(branchChip.textContent)
            .then(() => toast("Branch name copied", "ok"))
            .catch(() => {});
        });
      }

      if (mayEdit) {
        const editor = modalEl.querySelector("#tf-desc");
        const toolbar = modalEl.querySelector("#tf-desc-toolbar");
        document.execCommand("styleWithCSS", false, "false");
        // Prevent toolbar clicks from stealing the text selection.
        toolbar.addEventListener("mousedown", (e) => e.preventDefault());
        toolbar.addEventListener("click", (e) => {
          const btn = e.target.closest("button");
          if (!btn || btn.disabled) return;
          editor.focus();
          if (btn.dataset.cmd) {
            document.execCommand(btn.dataset.cmd, false, null);
          } else if (btn.dataset.block) {
            document.execCommand("formatBlock", false, btn.dataset.block.toUpperCase());
          }
          syncActive();
        });
        modalEl.querySelector("#tf-link").addEventListener("click", () => {
          const url = prompt("Link URL (https://...)");
          if (!url) return;
          editor.focus();
          document.execCommand("createLink", false, url);
          syncActive();
        });
        modalEl.querySelector("#tf-code").addEventListener("click", () => {
          editor.focus();
          const sel = window.getSelection();
          const txt = sel && !sel.isCollapsed ? sel.toString() : "";
          document.execCommand("insertHTML", false, `<pre><code>${esc(txt)}</code></pre><p></p>`);
          syncActive();
        });

        // Media upload: remember caret, pick a file, insert returned /media/ URL.
        const mediaInput = modalEl.querySelector("#tf-media-input");
        let savedRange = null;
        const openPicker = (accept) => {
          const sel = window.getSelection();
          savedRange = sel && sel.rangeCount && editor.contains(sel.anchorNode)
            ? sel.getRangeAt(0).cloneRange() : null;
          mediaInput.accept = accept;
          mediaInput.click();
        };
        modalEl.querySelector("#tf-image").addEventListener("click",
          () => openPicker("image/png,image/jpeg,image/gif,image/webp"));
        modalEl.querySelector("#tf-video").addEventListener("click",
          () => openPicker("video/mp4,video/webm,video/quicktime"));
        mediaInput.addEventListener("change", async () => {
          const file = mediaInput.files?.[0];
          mediaInput.value = "";
          if (!file) return;
          toast(`Uploading ${file.name}...`);
          try {
            const fd = new FormData();
            fd.append("file", file);
            const res = await api.upload(`/projects/${project.id}/media`, fd);
            editor.focus();
            if (savedRange) {
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(savedRange);
            }
            const html = res.type.startsWith("image/")
              ? `<img src="${esc(res.url)}" alt="${esc(file.name)}">`
              : `<video src="${esc(res.url)}" controls playsinline></video>`;
            document.execCommand("insertHTML", false, html + "<p><br></p>");
            ensureTrailingLine();
            syncActive();
            toast(`${file.name} added`, "ok");
          } catch (err) {
            toast(err.message || "Upload failed", "err");
          }
        });

        // Highlight toolbar buttons matching the formatting at the caret.
        const syncActive = () => {
          if (!document.contains(editor)) return;
          const sel = window.getSelection();
          if (!sel || !sel.anchorNode || !editor.contains(sel.anchorNode)) return;
          let block = "";
          try { block = String(document.queryCommandValue("formatBlock")).toLowerCase(); } catch { /* noop */ }
          toolbar.querySelectorAll("button").forEach((btn) => {
            let on = false;
            if (btn.dataset.cmd) {
              try { on = document.queryCommandState(btn.dataset.cmd); } catch { /* noop */ }
            } else if (btn.dataset.block) {
              on = block === btn.dataset.block.toLowerCase();
            }
            btn.classList.toggle("active", on);
          });
        };
        document.addEventListener("selectionchange", syncActive);
        editor.addEventListener("keyup", syncActive);
        editor.addEventListener("mouseup", syncActive);

        // Keep exactly one always-blank line open at the bottom, in realtime.
        const ensureTrailingLine = () => {
          const last = editor.lastElementChild;
          const blank = last && (last.tagName === "P" || last.tagName === "DIV")
            && last.textContent.trim() === "" && !last.querySelector("img,a");
          if (!blank) editor.insertAdjacentHTML("beforeend", "<p><br></p>");
        };
        editor.addEventListener("input", ensureTrailingLine);
        editor.addEventListener("input", syncActive);
        ensureTrailingLine();
      }

      // Auto-save every field as it changes.
      if (mayEdit) {
        const titleEl = modalEl.querySelector("#tf-title");
        const descEl = modalEl.querySelector("#tf-desc");
        const statusSel = modalEl.querySelector("#tf-status");
        const sprintSel = modalEl.querySelector("#tf-sprint");
        const prioritySel = modalEl.querySelector("#tf-priority");
        const typeSel = modalEl.querySelector("#tf-type");
        const assigneeSel = modalEl.querySelector("#tf-assignee");

        if (statusSel && !statusSel.disabled) statusSel.addEventListener("change", () => commit({ status: statusSel.value }));
        if (sprintSel && !sprintSel.disabled) sprintSel.addEventListener("change", () => commit({ sprintId: sprintSel.value || null }));
        if (prioritySel && !prioritySel.disabled) prioritySel.addEventListener("change", () => commit({ priority: prioritySel.value }));
        if (typeSel && !typeSel.disabled) typeSel.addEventListener("change", () => commit({ type: typeSel.value }));
        if (assigneeSel && !assigneeSel.disabled) assigneeSel.addEventListener("change", () => commit({ assigneeId: assigneeSel.value || null }));

        if (titleEl) {
          const saveTitle = debounce(() => {
            const v = titleEl.value.trim();
            if (!v) { if (!created) setSaveState("draft"); return; }
            commit({ title: v });
          }, 500);
          titleEl.addEventListener("input", saveTitle);
        }
        if (descEl) {
          const saveDesc = debounce(() => {
            const html = sanitizeDesc(descEl.innerHTML);
            commit({ description: isEmptyDesc(html) ? "" : html });
          }, 700);
          descEl.addEventListener("input", saveDesc);
        }
      }

      // Explicit save button: also catches Enter in the title field.
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!mayEdit) return;
        const saveBtn = form.querySelector("#tf-save");
        if (saveBtn) saveBtn.disabled = true;
        try {
          await fullSave();
        } catch (err) {
          setSaveState("error", err.message);
          toast(err.message, "err");
        } finally {
          if (saveBtn) saveBtn.disabled = false;
        }
      });

      const delBtn = modalEl.querySelector("#tf-delete");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          if (!confirm(`Delete ${task.ticketId}? This cannot be undone.`)) return;
          delBtn.disabled = true;
          try {
            await api.del(`/projects/${project.id}/tasks/${task.id}`);
            removeLocal(task.id);
            close();
            refreshColumns();
            toast(`${task.ticketId} deleted`, "ok");
          } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.remove("hidden");
            delBtn.disabled = false;
          }
        });
      }
    },
  });
}

function allowedTargetList(from) {
  return STATUSES
    .filter((s) => s === from || canTransition(from, s))
    .map((value) => ({ value, label: STATUS_LABELS[value] }));
}

/* ---------- Ticket activity log ---------- */

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function actText(ev) {
  const arrow = `<span class="act-arrow">&rarr;</span>`;
  switch (ev.type) {
    case "CREATED":
      return ev.newStatus ? `created this ticket as ${statusPill(ev.newStatus, undefined, true)}` : "created this ticket";
    case "STATUS_CHANGED":
      return `moved ${statusPill(ev.oldStatus, undefined, true)} ${arrow} ${statusPill(ev.newStatus, undefined, true)}`;
    case "TITLE_CHANGED":
      return `renamed <del class="act-old">${esc(truncate(ev.oldValue, 80))}</del> ${arrow} <b>${esc(truncate(ev.newValue, 80))}</b>`;
    case "DESCRIPTION_CHANGED": {
      let t = "updated the description";
      const prev = truncate(ev.newValue, 120);
      if (prev) t += `<div class="act-quote">${esc(prev)}</div>`;
      return t;
    }
    case "ASSIGNEE_CHANGED":
      return `changed assignee <b>${esc(ev.oldValue || "Unassigned")}</b> ${arrow} <b>${esc(ev.newValue || "Unassigned")}</b>`;
    case "SPRINT_CHANGED":
      return `changed sprint <b>${esc(ev.oldValue || "Backlog")}</b> ${arrow} <b>${esc(ev.newValue || "Backlog")}</b>`;
    default:
      return esc(String(ev.type || "").toLowerCase().replaceAll("_", " "));
  }
}

function activityItemHtml(ev) {
  const who = ev.actorName || "Someone";
  return `
  <li class="activity-item">
    ${avatarHtml(who, ev.actorId)}
    <div class="act-body">
      <div class="act-text"><b>${esc(who)}</b> ${actText(ev)}</div>
      <div class="act-when">${fmtDate(ev.createdAt)}</div>
    </div>
  </li>`;
}

function loadActivity(listEl, taskId) {
  api.get(`/projects/${project.id}/tasks/${taskId}/events`)
    .then((events) => {
      // Newest first.
      const desc = [...events].reverse();
      listEl.innerHTML = desc.length
        ? desc.map(activityItemHtml).join("")
        : `<li class="act-empty">No activity yet.</li>`;
    })
    .catch(() => {
      listEl.innerHTML = `<li class="act-empty">Activity could not be loaded.</li>`;
    });
}

/* ---------- Comments (any member can comment on any ticket; @mentions supported) ---------- */

function renderCommentBody(body) {
  // Sanitize HTML from the contenteditable, then turn @[Name](userId) tokens into mention chips.
  let html = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<\/?(?:iframe|object|embed|form|input|textarea|select|button|meta|link)[^>]*>/gi, "");
  html = html.replace(/\[@([^\]]+)\]\(([^)]+)\)/g, (_m, name, id) =>
    `<span class="mention${id === state.user?.id ? " me" : ""}">@${name}</span>`);
  return html;
}

function commentItemHtml(c) {
  const who = c.authorName || "Unknown";
  return `
  <li class="comment-item">
    ${avatarHtml(who, c.authorId)}
    <div class="comment-body">
      <div class="comment-meta"><b>${esc(who)}</b><span class="act-when">${fmtDate(c.createdAt)}</span></div>
      <div class="comment-text">${renderCommentBody(c.body)}</div>
    </div>
  </li>`;
}

function setupComments(modalEl, listEl, taskId) {
  const input = modalEl.querySelector("#tf-comment-input");
  const toolbar = modalEl.querySelector("#tf-comment-toolbar");
  const sendBtn = modalEl.querySelector("#tf-comment-send");
  const menu = modalEl.querySelector("#tf-mention-menu");
  let items = [];

  /* Comment RTE toolbar (same as the description editor) */
  document.execCommand("styleWithCSS", false, "false");
  toolbar.addEventListener("mousedown", (e) => e.preventDefault());
  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    input.focus();
    if (btn.dataset.cmd) {
      document.execCommand(btn.dataset.cmd, false, null);
    } else if (btn.dataset.block) {
      document.execCommand("formatBlock", false, btn.dataset.block.toUpperCase());
    }
    syncActive();
  });
  modalEl.querySelector("#tf-comment-link").addEventListener("click", () => {
    const url = prompt("Link URL (https://...)");
    if (!url) return;
    input.focus();
    document.execCommand("createLink", false, url);
    syncActive();
  });
  modalEl.querySelector("#tf-comment-code").addEventListener("click", () => {
    input.focus();
    const sel = window.getSelection();
    const txt = sel && !sel.isCollapsed ? sel.toString() : "";
    document.execCommand("insertHTML", false, `<pre><code>${esc(txt)}</code></pre><p></p>`);
    syncActive();
  });

  /* Media upload: remember caret, pick a file, insert returned /media/ URL. */
  const mediaInput = modalEl.querySelector("#tf-comment-media-input");
  let savedRange = null;
  const openPicker = (accept) => {
    const sel = window.getSelection();
    savedRange = sel && sel.rangeCount && input.contains(sel.anchorNode)
      ? sel.getRangeAt(0).cloneRange() : null;
    mediaInput.accept = accept;
    mediaInput.click();
  };
  modalEl.querySelector("#tf-comment-image").addEventListener("click",
    () => openPicker("image/png,image/jpeg,image/gif,image/webp"));
  modalEl.querySelector("#tf-comment-video").addEventListener("click",
    () => openPicker("video/mp4,video/webm,video/quicktime"));
  mediaInput.addEventListener("change", async () => {
    const file = mediaInput.files?.[0];
    mediaInput.value = "";
    if (!file) return;
    toast(`Uploading ${file.name}...`);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.upload(`/projects/${project.id}/media`, fd);
      input.focus();
      if (savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
      const html = res.type.startsWith("image/")
        ? `<img src="${esc(res.url)}" alt="${esc(file.name)}">`
        : `<video src="${esc(res.url)}" controls playsinline></video>`;
      document.execCommand("insertHTML", false, html + "<p><br></p>");
      syncActive();
      toast(`${file.name} added`, "ok");
    } catch (err) {
      toast(err.message || "Upload failed", "err");
    }
  });

  /* Highlight toolbar buttons matching the formatting at the caret. */
  const syncActive = () => {
    if (!document.contains(input)) return;
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !input.contains(sel.anchorNode)) return;
    let block = "";
    try { block = String(document.queryCommandValue("formatBlock")).toLowerCase(); } catch { /* noop */ }
    toolbar.querySelectorAll("button").forEach((btn) => {
      let on = false;
      if (btn.dataset.cmd) {
        try { on = document.queryCommandState(btn.dataset.cmd); } catch { /* noop */ }
      } else if (btn.dataset.block) {
        on = block === btn.dataset.block.toLowerCase();
      }
      btn.classList.toggle("active", on);
    });
  };
  document.addEventListener("selectionchange", syncActive);
  input.addEventListener("keyup", syncActive);
  input.addEventListener("mouseup", syncActive);

  /* Placeholder behavior */
  const updatePlaceholder = () => {
    input.classList.toggle("empty", input.textContent.trim() === "");
  };
  input.addEventListener("input", updatePlaceholder);
  updatePlaceholder();

  const hideMenu = () => menu.classList.add("hidden");

  const load = () =>
    api.get(`/projects/${project.id}/tasks/${taskId}/comments`)
      .then((rows) => {
        items = [...rows].sort((a, b) => b.createdAt - a.createdAt);
        listEl.innerHTML = items.length
          ? items.map(commentItemHtml).join("")
          : `<li class="act-empty">No comments yet.</li>`;
      })
      .catch(() => { listEl.innerHTML = `<li class="act-empty">Comments could not be loaded.</li>`; });
  load();

  const submit = async () => {
    const body = input.innerHTML.trim();
    if (!body || input.textContent.trim() === "") return;
    sendBtn.disabled = true;
    try {
      const created = await api.post(`/projects/${project.id}/tasks/${taskId}/comments`, { body });
      items.unshift(created);
      listEl.innerHTML = items.map(commentItemHtml).join("");
      input.innerHTML = "";
      updatePlaceholder();
      hideMenu();
    } catch (err) {
      toast(err.message || "Comment failed", "err");
    } finally {
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });

  /* @mention autocomplete over project members */
  const members = project.members || [];
  let matches = [];
  let activeIdx = 0;

  const applyMatch = (m) => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return hideMenu();
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    const offset = range.startOffset;
    const text = container.nodeType === 3 ? container.textContent : "";
    const before = text.slice(0, offset);
    const at = before.lastIndexOf("@");
    if (at === -1) return hideMenu();
    const token = `@[${m.name}](${m.userId}) `;
    const after = text.slice(offset);
    if (container.nodeType === 3) {
      container.textContent = before.slice(0, at) + token + after;
      const newPos = at + token.length;
      range.setStart(container, newPos);
      range.setEnd(container, newPos);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    hideMenu();
  };

  const showMenu = () => {
    if (!matches.length) return hideMenu();
    menu.innerHTML = matches.map((m, i) => `
      <button type="button" class="mention-item${i === activeIdx ? " active" : ""}" data-i="${i}">
        ${avatarHtml(m.name, m.userId)} ${esc(m.name)} <span class="mention-email">${esc(m.email)}</span>
      </button>`).join("");
    menu.classList.remove("hidden");
    menu.querySelectorAll(".mention-item").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applyMatch(matches[Number(btn.dataset.i)]);
        input.focus();
      });
    });
  };

  input.addEventListener("input", () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !input.contains(sel.anchorNode)) return hideMenu();
    const container = sel.anchorContainer || sel.anchorNode;
    const text = container.nodeType === 3 ? container.textContent : "";
    const pos = container.nodeType === 3 ? sel.anchorOffset : text.length;
    const before = text.slice(0, pos);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) return hideMenu();
    const q = m[2].toLowerCase();
    matches = members.filter((mm) => mm.name.toLowerCase().includes(q)).slice(0, 6);
    activeIdx = 0;
    showMenu();
  });

  input.addEventListener("keydown", (e) => {
    if (menu.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, matches.length - 1); showMenu(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); showMenu(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMatch(matches[activeIdx]); input.focus(); }
    else if (e.key === "Escape") hideMenu();
  });
  input.addEventListener("blur", () => setTimeout(hideMenu, 120));
}
