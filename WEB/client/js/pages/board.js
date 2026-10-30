import { api } from "../api.js";
import { navigate, requireAuth, state } from "../main.js";
import {
  STATUSES, getStatusColor, STATUS_LABELS, canTransition,
  esc, avatarHtml, statusPill, openModal, toast, fmtDate,
  sanitizeDesc, descToEditorHtml, isEmptyDesc,
  TASK_TYPES, TYPE_LABELS, PRIORITIES, PRIORITY_LABELS, priorityPill, branchName, bulkDeleteTickets, sortTickets,
} from "../ui.js";
import { t as tl, labels } from "../i18n.js";
import { openSyncImport } from "./sync-import.js";
import { exportTicketsPdf, openExportDialog, printSections, ticketTablesHtml } from "../export-pdf.js";
import { filterRowHtml, bindFilterRow } from "../filters.js";
import { taskModal, actText, bindTaskModal } from "./board/task-modal.js";

let project = null;
let myRole = "MEMBER";
let tasks = [];
let filterText = "";
// Multi-select filters (empty set = All). Kept in the URL as ?f.<key>=a,b so a refresh keeps them.
const FILTER_KEYS = ["sprint", "assignee", "status", "priority", "type", "label", "due"];
const filterSel = Object.fromEntries(FILTER_KEYS.map((k) => [k, new Set()]));
const DUE_OPTIONS = ["overdue", "week", "none"];
let collapsedLanes = new Set();
let boardStream = null;
let refreshTimer = null;
let selectedIds = new Set();
let viewMode = localStorage.getItem("tm-ticket-view") || "board";
// sort "priority": urgent first, then oldest; "manual": drag order. group: a lane per sprint, or every ticket together.
let sortMode = localStorage.getItem("tm-ticket-sort") === "manual" ? "manual" : "priority";
let groupMode = localStorage.getItem("tm-ticket-group") === "all" ? "all" : "sprint";

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
  readFiltersFromUrl();
  collapsedLanes = new Set();
  selectedIds = new Set();
  if (initialSprint && (initialSprint === "backlog" || project.sprints.some((s) => s.id === initialSprint))) {
    for (const s of project.sprints) {
      if (s.id !== initialSprint) collapsedLanes.add(s.id);
    }
    if (initialSprint !== "backlog") collapsedLanes.add("backlog");
  } else {
    // Sprints whose tickets are all DONE start collapsed.
    for (const s of project.sprints) {
      const inSprint = tasks.filter((t) => t.sprintId === s.id);
      if (inSprint.length && inSprint.every((t) => t.status === "DONE")) collapsedLanes.add(s.id);
    }
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
        <span>${tl("bd.mAdminHint", { panel: `<strong>${tl("bd.adminPanel")}</strong>` })}</span>
        <a class="btn sm ghost" href="/admin/users" data-nav>${tl("bd.openAdmin")}</a>
      </div>` : ""}
      <div class="table-card">
        <table class="data">
          <thead><tr><th>${tl("bd.name")}</th><th>${tl("bd.email")}</th><th>${tl("bd.projectRole")}</th></tr></thead>
          <tbody>
            ${project.members.map((m) => `
              <tr>
                <td style="display:flex;align-items:center;gap:10px">${avatarHtml(m.name, m.userId)} ${esc(m.name)}</td>
                <td>${esc(m.email)}</td>
                <td>${m.role === "ADMIN"
                  ? `<span class="role-chip role-admin">${tl("role.ADMIN")}</span>`
                  : `<span class="role-chip role-member">${tl("role.MEMBER")}</span>`}</td>
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
        <span>${tl("bd.sprintHint")}</span>
      </div>` : ""}
      <div class="table-card">
        <table class="data">
          <thead><tr><th>${tl("bd.sprintId")}</th><th>${tl("bd.name")}</th><th>${tl("bd.tickets")}</th>${canManage ? "<th></th>" : ""}</tr></thead>
          <tbody>
            ${project.sprints.map((s) => sprintRow(s, canManage)).join("")}
          </tbody>
        </table>
      </div>
      ${canManage ? `<div class="modal-actions" style="margin-top:14px"><button class="btn sm" id="add-sprint-btn">${tl("bd.newSprint")}</button></div>` : ""}
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
      if (!confirm(tl("bd.sprintDeleteConfirm", { id: s.sprintId, name: s.name, count: Number(s.ticketCount ?? 0) }))) return;
      btn.disabled = true;
      try {
        await api.del(`/projects/${project.id}/sprints/${sid}`);
        toast(tl("bd.sprintDeleted", { id: s.sprintId }), "ok");
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
        <a class="btn sm ghost" href="/projects/${encodeURIComponent(project.id)}?sprint=${encodeURIComponent(s.id)}" data-nav>${tl("bd.openBoard")}</a>
        ${canManage ? `<button class="btn ghost sm" data-rename="${esc(s.id)}">${tl("bd.rename")}</button>
        <button class="btn danger sm" data-delete="${esc(s.id)}">${tl("bd.delete")}</button>` : ""}
      </td>
    </tr>`;
}

function openSprintModal(existing) {
  const isEdit = Boolean(existing);
  openModal({
    title: isEdit ? tl("bd.renameSprint") : tl("bd.newSprint").replace(/^\+\s*/, ""),
    body: `
      <div class="field">
        <label for="sp-name">${tl("bd.name")}</label>
        <input type="text" id="sp-name" placeholder="${tl("bd.sprintPh")}" value="${isEdit ? esc(existing.name) : ""}" />
        ${isEdit
          ? `<div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("bd.sprintIdFixed", { id: `<span class="ticket-id">${esc(existing.sprintId)}</span>` })}</div>`
          : `<div style="color:var(--text-dim);font-size:12px;margin-top:4px">${tl("bd.sprintIdAuto", { id: `<span class="ticket-id">${esc(nextSprintPreview())}</span>` })}</div>`}
      </div>
      <div class="modal-actions">
        <span></span>
        <span class="right">
          <button class="btn ghost" id="sp-cancel">${tl("bd.cancel")}</button>
          <button class="btn" id="sp-save">${isEdit ? tl("bd.save") : tl("bd.create")}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      modalEl.querySelector("#sp-cancel").addEventListener("click", close);
      const save = modalEl.querySelector("#sp-save");
      save.addEventListener("click", async () => {
        const name = modalEl.querySelector("#sp-name").value.trim();
        if (!name) { toast(tl("bd.nameRequired"), "err"); return; }
        save.disabled = true;
        try {
          if (isEdit) {
            await api.patch(`/projects/${project.id}/sprints/${existing.id}`, { name });
            toast(tl("bd.sprintRenamed"), "ok");
          } else {
            await api.post(`/projects/${project.id}/sprints`, { name });
            toast(tl("bd.sprintCreated"), "ok");
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
        ${myRole === "ADMIN" ? `<span class="role-chip role-admin">${tl("bd.youAdmin")}</span>` : ""}
      </div>
      <nav class="tabs">
        <button class="tab ${activeTab === "board" ? "active" : ""}" data-tab="board">${tl("bd.tabBoard", { count: tasks.length })}</button>
        <button class="tab ${activeTab === "members" ? "active" : ""}" data-tab="members">${tl("bd.tabMembers", { count: project.members.length })}</button>
        <button class="tab ${activeTab === "sprints" ? "active" : ""}" data-tab="sprints">${tl("bd.tabSprints", { count: project.sprints.length })}</button>
        ${project.githubRepo ? `<button class="tab" data-tab="graph">${tl("bd.tabGraph")}</button>` : ""}
      </nav>
    </div>`;
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      const base = `/projects/${project.id}`;
      navigate(tab === "members" ? `${base}/members` : tab === "sprints" ? `${base}/sprints` : tab === "graph" ? `${base}/graph` : base);
    });
  });
}

function drawShell(root) {
  root.innerHTML = `
    ${headHtml("board")}
    <div class="toolbar">
      <input type="text" class="search" id="filter-text" placeholder="${tl("bd.searchPh")}" value="${esc(filterText)}" />
      <div class="btn-group view-toggle" role="group" aria-label="${tl("bd.view")}">
        <button class="btn sm ${viewMode === "board" ? "" : "ghost"}" id="view-board-btn" title="${tl("bd.boardView")}">${tl("bd.board")}</button>
        <button class="btn sm ${viewMode === "list" ? "" : "ghost"}" id="view-list-btn" title="${tl("bd.listView")}">${tl("bd.list")}</button>
      </div>
      <select id="group-mode" aria-label="${tl("bd.group")}" title="${tl("bd.group")}">
        <option value="sprint"${groupMode === "sprint" ? " selected" : ""}>${tl("bd.groupSprint")}</option>
        <option value="all"${groupMode === "all" ? " selected" : ""}>${tl("bd.groupAll")}</option>
      </select>
      <select id="sort-mode" aria-label="${tl("bd.sort")}" title="${tl("bd.sort")}">
        <option value="priority"${sortMode === "priority" ? " selected" : ""}>${tl("bd.sortPriority")}</option>
        <option value="manual"${sortMode === "manual" ? " selected" : ""}>${tl("bd.sortManual")}</option>
      </select>
      <div class="btn-group">
        ${myRole === "ADMIN" ? `<button class="btn sm ghost" id="sync-btn" title="${tl("sync.hint")}">${tl("sync.button")}</button>` : ""}
        <button class="btn sm ghost" id="export-btn">${tl("bd.exportJson")}</button>
        <button class="btn sm ghost" id="export-csv-btn">${tl("bd.exportCsv")}</button>
        <button class="btn sm ghost" id="export-pdf-btn" title="${tl("pdf.title")}">${tl("pdf.button")}</button>
        <button class="btn sm" id="new-task-btn">${tl("bd.newTicket")}</button>
      </div>
    </div>
    ${filterRowHtml(filterDefs(), filterSel)}
    <div class="board-scroll">
      <div class="board">
        ${groupMode === "all" ? allLaneHtml() : project.sprints.map((s) => laneHtml(s)).join("") + backlogLaneHtml()}
      </div>
    </div>
    <div class="bulk-bar hidden" id="bulk-bar"></div>`;

  bindTabs();
  document.getElementById("view-board-btn").addEventListener("click", () => setViewMode(root, "board"));
  document.getElementById("view-list-btn").addEventListener("click", () => setViewMode(root, "list"));
  document.getElementById("group-mode").addEventListener("change", (e) => {
    groupMode = e.target.value;
    localStorage.setItem("tm-ticket-group", groupMode);
    drawShell(root);
  });
  document.getElementById("sort-mode").addEventListener("change", (e) => {
    sortMode = e.target.value;
    localStorage.setItem("tm-ticket-sort", sortMode);
    refreshColumns();
  });
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
      toast(err.message || tl("bd.exportFailed"), "error");
    }
  });
  document.getElementById("export-csv-btn").addEventListener("click", async () => {
    try {
      // With filters/search active only the matching tickets are exported.
      const ids = tasks.filter(matchesFilters).map((t) => t.ticketId);
      const filtered = hasActiveFilters() && ids.length < tasks.length;
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/export?format=csv${filtered ? `&ids=${encodeURIComponent(ids.join(","))}` : ""}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || tl("bd.exportFailed"));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.prefix}-export.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(err.message || tl("bd.exportFailed"), "error");
    }
  });
  openBoardStream(project.id);

  document.getElementById("sync-btn")?.addEventListener("click", () => openSyncImport(project));
  const searchEl = document.getElementById("filter-text");
  searchEl.addEventListener("input", () => { filterText = searchEl.value.toLowerCase(); refreshColumns(); });

  bindFilterRow(root, filterDefs(), filterSel, () => { syncFiltersToUrl(); refreshColumns(); });
  document.getElementById("export-pdf-btn").addEventListener("click", openBoardPdf);

  // Lane collapse toggles
  root.querySelectorAll(".sprint-lane-head").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest("button, .select-group")) return;
      const id = head.dataset.toggle;
      if (collapsedLanes.has(id)) collapsedLanes.delete(id);
      else collapsedLanes.add(id);
      drawShell(root);
    });
  });

  // "+ Create" inside each lane column
  root.querySelectorAll(".col-add").forEach((btn) =>
    btn.addEventListener("click", () => taskModal(null, btn.dataset.add, btn.dataset.lane === "all" ? "" : btn.dataset.lane || ""))
  );

  // "+" in a sprint header: sprint preselected, status stays the default (To Do)
  root.querySelectorAll(".lane-add").forEach((btn) =>
    btn.addEventListener("click", () => taskModal(null, "TODO", btn.dataset.addLane))
  );

  bindDragAndDrop();
  root.querySelectorAll(".select-group").forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      const ids = groupTaskIds(cb.dataset.lane, cb.dataset.status);
      for (const id of ids) { if (cb.checked) selectedIds.add(id); else selectedIds.delete(id); }
      syncCardCheckboxes();
      renderBulkBar();
    });
  });
  refreshColumns();
}

// Tickets a "select all" box covers: one status column inside one sprint lane,
// or the whole lane. Only what is currently visible (search / assignee filter).
function groupTaskIds(laneId, status) {
  const list = status ? visibleTasks(status, laneId) : STATUSES.flatMap((s) => visibleTasks(s, laneId));
  return list.map((t) => t.id);
}

function syncCardCheckboxes() {
  document.querySelectorAll(".card-select").forEach((cb) => {
    const on = selectedIds.has(cb.dataset.select);
    cb.checked = on;
    cb.closest(".card, .list-row")?.classList.toggle("selected", on);
  });
}

// Checked = everything in the group is selected, indeterminate = some of it.
function updateSelectGroups() {
  document.querySelectorAll(".select-group").forEach((cb) => {
    const ids = groupTaskIds(cb.dataset.lane, cb.dataset.status);
    const n = ids.filter((id) => selectedIds.has(id)).length;
    cb.disabled = ids.length === 0;
    cb.checked = ids.length > 0 && n === ids.length;
    cb.indeterminate = n > 0 && n < ids.length;
  });
}

function setViewMode(root, mode) {
  if (mode === viewMode) return;
  viewMode = mode;
  localStorage.setItem("tm-ticket-view", mode);
  drawShell(root);
}

/* ---------- Swim-lane helpers ---------- */

function laneBodyHtml(laneId) {
  return viewMode === "list"
    ? laneListHtml(laneId)
    : `<div class="lane-columns">${STATUSES.map((s) => laneColumnHtml(laneId, s)).join("")}</div>`;
}

function parseLabelInput(text) {
  return String(text || "").split(",").map((l) => l.trim()).filter(Boolean);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function canCreateTicket() {
  return myRole === "ADMIN" || (project?.myPermissions || []).includes("CREATE_TICKET");
}

function workItems(n) {
  return n === 1 ? tl("bd.workItem.one") : tl("bd.workItem.many", { count: n });
}

function laneHtml(sprint) {
  const collapsed = collapsedLanes.has(sprint.id);
  return `
    <section class="sprint-lane${collapsed ? " collapsed" : ""}" data-lane="${esc(sprint.id)}">
      <div class="sprint-lane-head" data-toggle="${esc(sprint.id)}">
        <input type="checkbox" class="select-group lane-select" data-lane="${esc(sprint.id)}" title="${tl("bd.selectLane")}" aria-label="${tl("bd.selectLane")}" />
        <span class="lane-arrow">${collapsed ? "\u25B6" : "\u25BC"}</span>
        <span class="ticket-id lane-id">${esc(sprint.sprintId)}</span>
        <span class="lane-name">${esc(sprint.name)}</span>
        <span class="lane-count">${workItems(tasks.filter((t) => t.sprintId === sprint.id).length)}</span>
        ${canCreateTicket() ? `<button class="col-add lane-add" data-add-lane="${esc(sprint.id)}" title="${tl("bd.addToSprint")}" aria-label="${tl("bd.addToSprint")}">+</button>` : ""}
      </div>
      ${collapsed ? "" : laneBodyHtml(sprint.id)}
    </section>`;
}

function allLaneHtml() {
  const collapsed = collapsedLanes.has("all");
  return `
    <section class="sprint-lane${collapsed ? " collapsed" : ""}" data-lane="all">
      <div class="sprint-lane-head" data-toggle="all">
        <input type="checkbox" class="select-group lane-select" data-lane="all" title="${tl("bd.selectLane")}" aria-label="${tl("bd.selectLane")}" />
        <span class="lane-arrow">${collapsed ? "\u25B6" : "\u25BC"}</span>
        <span class="lane-name">${tl("bd.allTickets")}</span>
        <span class="lane-count">${workItems(tasks.length)}</span>
      </div>
      ${collapsed ? "" : laneBodyHtml("all")}
    </section>`;
}

function backlogLaneHtml() {
  const count = tasks.filter((t) => !t.sprintId).length;
  const collapsed = collapsedLanes.has("backlog");
  return `
    <section class="sprint-lane backlog-lane${collapsed ? " collapsed" : ""}" data-lane="backlog">
      <div class="sprint-lane-head" data-toggle="backlog">
        <input type="checkbox" class="select-group lane-select" data-lane="backlog" title="${tl("bd.selectLane")}" aria-label="${tl("bd.selectLane")}" />
        <span class="lane-arrow">${collapsed ? "\u25B6" : "\u25BC"}</span>
        <span class="lane-name">${tl("bd.everythingElse")}</span>
        <span class="lane-count">${workItems(count)}</span>
        ${canCreateTicket() ? `<button class="col-add lane-add" data-add-lane="" title="${tl("bd.addHere")}" aria-label="${tl("bd.addHere")}">+</button>` : ""}
      </div>
      ${collapsed ? "" : laneBodyHtml("backlog")}
    </section>`;
}

/* ---------- List view ---------- */

function laneListHtml(laneId) {
  return `
    <table class="data list-table" data-lane="${esc(laneId)}">
      <thead><tr><th><input type="checkbox" class="select-group lane-select" data-lane="${esc(laneId)}" title="${tl("bd.selectLane")}" aria-label="${tl("bd.selectLane")}" /></th><th>${tl("bd.colTicket")}</th><th>${tl("bd.colTitle")}</th><th>${tl("bd.colLabels")}</th><th><button type="button" class="th-sort" data-sort-status title="${tl("bd.sortStatus")}">${tl("bd.colStatus")} <span class="sort-arrow">${statusSortDesc ? "\u25BC" : "\u25B2"}</span></button></th><th>${tl("bd.colType")}</th><th>${tl("bd.colPriority")}</th><th>${tl("bd.colAssignee")}</th></tr></thead>
      <tbody></tbody>
    </table>`;
}

let statusSortDesc = false;

function laneTasksForList(laneId) {
  const order = statusSortDesc ? [...STATUSES].reverse() : STATUSES;
  return order.flatMap((s) => visibleTasks(s, laneId));
}

function rowHtml(t) {
  const assignee = memberById(t.assigneeId);
  const checked = selectedIds.has(t.id);
  return `
    <tr class="list-row${checked ? " selected" : ""}" data-id="${esc(t.id)}">
      <td><input type="checkbox" class="card-select" data-select="${esc(t.id)}" ${checked ? "checked" : ""} title="${tl("bd.selectTicket")}" /></td>
      <td class="ticket-id">${esc(t.ticketId)}</td>
      <td class="title-cell">${esc(t.title)}</td>
      <td>${t.labels?.length ? `<div class="card-labels" style="margin-top:0">${t.labels.map((l) => `<span class="label-chip">${esc(l)}</span>`).join("")}</div>` : ""}</td>
      <td>${statusPill(t.status)}</td>
      <td>${TYPE_LABELS[t.type]}</td>
      <td>${priorityPill(t.priority)}</td>
      <td>${assignee ? esc(assignee.name) : "Unassigned"}</td>
    </tr>`;
}

function refreshListTables() {
  document.querySelectorAll("[data-sort-status]").forEach((btn) => {
    btn.querySelector(".sort-arrow").textContent = statusSortDesc ? "\u25BC" : "\u25B2";
    btn.onclick = () => { statusSortDesc = !statusSortDesc; refreshListTables(); };
  });
  document.querySelectorAll(".list-table").forEach((table) => {
    const laneId = table.dataset.lane;
    const tbody = table.querySelector("tbody");
    const list = laneTasksForList(laneId);
    tbody.innerHTML = list.length ? list.map(rowHtml).join("") : `<tr><td colspan="8" class="list-empty">${tl("bd.noTickets")}</td></tr>`;
    tbody.querySelectorAll(".list-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".card-select")) return;
        const t = tasks.find((x) => x.id === row.dataset.id);
        if (t) taskModal(t);
      });
      bindSelectable(row, row.dataset.id);
    });
  });
}

function bindSelectable(el, taskId) {
  const cb = el.querySelector(".card-select");
  if (!cb) return;
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    if (cb.checked) selectedIds.add(taskId);
    else selectedIds.delete(taskId);
    el.classList.toggle("selected", cb.checked);
    renderBulkBar();
  });
}

function laneColumnHtml(laneId, status) {
  return `
    <section class="column" data-lane="${esc(laneId)}" data-status="${status}">
      <header class="col-head">
        <input type="checkbox" class="select-group col-select" data-lane="${esc(laneId)}" data-status="${status}" title="${tl("bd.selectColumn")}" aria-label="${tl("bd.selectColumn")}" />
        <span class="col-dot" style="background:${getStatusColor(status)}"></span>
        <span class="col-label">${STATUS_LABELS[status]}</span>
        <span class="col-count" data-count>0</span>
        <button class="col-add" data-add="${status}" data-lane="${esc(laneId)}" title="${tl("bd.addHere")}">+</button>
      </header>
      <div class="col-body" data-body="${status}"></div>
    </section>`;
}

function cardHtml(t) {
  const assignee = memberById(t.assigneeId);
  const movable = canModifyTask(t);
  const checked = selectedIds.has(t.id);
  return `
    <article class="card ticket ${movable ? "" : "locked"}${checked ? " selected" : ""}" draggable="${movable}" data-id="${esc(t.id)}">
      <div class="ticket-shape">
      <div class="ticket-body">
        <p class="title">${esc(t.title)}</p>
        ${t.labels?.length ? `<div class="card-labels">${t.labels.map((l) => `<span class="label-chip">${esc(l)}</span>`).join("")}</div>` : ""}
        ${t.dueDate ? `<div class="card-due${t.status !== "DONE" && t.dueDate < todayStr() ? " overdue" : ""}">${tl("bd.due", { date: esc(t.dueDate) })}</div>` : ""}
      </div>
      <div class="row ticket-stub">
        <input type="checkbox" class="card-select" data-select="${esc(t.id)}" ${checked ? "checked" : ""} title="${tl("bd.selectTicket")}" />
        <span class="ticket-id">${esc(t.ticketId)}</span>
        <span class="card-meta">
          ${priorityPill(t.priority)}
          <span class="assignee">
            ${assignee
              ? `${avatarHtml(assignee.name, assignee.userId)}<span class="nm">${esc(assignee.name.split(" ")[0])}</span>`
              : `<span class="nm">${tl("bd.unassigned")}</span>`}
          </span>
        </span>
      </div>
      </div>
    </article>`;
}

// Mirrors the server: project admins, or members granted DELETE_TICKET.
function canDeleteTickets() {
  return myRole === "ADMIN" || (project?.myPermissions || []).includes("DELETE_TICKET");
}

function memberById(id) {
  return project.members.find((m) => m.userId === id) || null;
}

function canModifyTask(t) {
  if (myRole === "ADMIN") return true;
  return t.assigneeId === state.user.id || t.createdBy === state.user.id;
}

function filterDefs() {
  const labelSet = [...new Set(tasks.flatMap((t) => t.labels ?? []))].sort();
  const opt = (value, label) => ({ value, label });
  return [
    { key: "sprint", label: tl("flt.sprint"), options: [...project.sprints.map((s) => opt(s.id, `${s.sprintId} - ${s.name}`)), opt("backlog", tl("bd.backlog"))] },
    { key: "assignee", label: tl("flt.assignee"), options: [...project.members.map((m) => opt(m.userId, m.name)), opt("none", tl("bd.unassigned"))] },
    { key: "status", label: tl("flt.status"), options: STATUSES.map((v) => opt(v, STATUS_LABELS[v])) },
    { key: "priority", label: tl("flt.priority"), options: PRIORITIES.map((v) => opt(v, PRIORITY_LABELS[v])) },
    { key: "type", label: tl("flt.type"), options: TASK_TYPES.map((v) => opt(v, TYPE_LABELS[v])) },
    ...(labelSet.length ? [{ key: "label", label: tl("flt.label"), options: labelSet.map((v) => opt(v, v)) }] : []),
    { key: "due", label: tl("flt.due"), options: DUE_OPTIONS.map((v) => opt(v, tl(`flt.due.${v}`))) },
  ];
}

function readFiltersFromUrl() {
  const q = new URLSearchParams(location.search);
  for (const k of FILTER_KEYS) {
    filterSel[k] = new Set((q.get(`f.${k}`) || "").split(",").filter(Boolean));
  }
}

function syncFiltersToUrl() {
  const q = new URLSearchParams(location.search);
  for (const k of FILTER_KEYS) {
    if (filterSel[k].size) q.set(`f.${k}`, [...filterSel[k]].join(","));
    else q.delete(`f.${k}`);
  }
  const qs = q.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
}

function hasActiveFilters() {
  return Boolean(filterText) || FILTER_KEYS.some((k) => filterSel[k].size > 0);
}

function matchesFilters(t) {
  const f = filterSel;
  if (filterText && !t.title.toLowerCase().includes(filterText) && !t.ticketId.toLowerCase().includes(filterText)) return false;
  if (f.sprint.size && !f.sprint.has(t.sprintId || "backlog")) return false;
  if (f.assignee.size && !f.assignee.has(t.assigneeId || "none")) return false;
  if (f.status.size && !f.status.has(t.status)) return false;
  if (f.priority.size && !f.priority.has(t.priority)) return false;
  if (f.type.size && !f.type.has(t.type)) return false;
  if (f.label.size && !(t.labels ?? []).some((l) => f.label.has(l))) return false;
  if (f.due.size) {
    const today = todayStr();
    const weekEnd = new Date(Date.now() + 7 * 864e5);
    const end = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, "0")}-${String(weekEnd.getDate()).padStart(2, "0")}`;
    const ok = (f.due.has("none") && !t.dueDate)
      || (f.due.has("overdue") && t.dueDate && t.dueDate < today && t.status !== "DONE")
      || (f.due.has("week") && t.dueDate && t.dueDate >= today && t.dueDate <= end);
    if (!ok) return false;
  }
  return true;
}

// A sprint filter also hides the swim lanes that were not picked.
function applyLaneFilter() {
  document.querySelectorAll(".sprint-lane[data-lane]").forEach((lane) => {
    lane.classList.toggle("hidden", lane.dataset.lane !== "all" && filterSel.sprint.size > 0 && !filterSel.sprint.has(lane.dataset.lane));
  });
}

// PDF of the tickets the filters currently show (one table per project).
function openBoardPdf() {
  openExportDialog({
    title: tl("pdf.title"),
    fields: [],
    onExport: async ({ paper }) => {
      const list = tasks.filter(matchesFilters).map((t) => ({ ...t, projectId: project.id, projectName: project.name, projectPrefix: project.prefix }));
      await printSections(tl("pdf.doc.tickets"), [{ title: `${project.prefix} - ${project.name}`, html: ticketTablesHtml(list) }], paper);
    },
  });
}

function visibleTasks(status, laneId) {
  return sortTickets(tasks
    .filter((t) => t.status === status)
    .filter((t) => {
      if (laneId === "all") return true;
      if (laneId === "backlog") return !t.sprintId;
      return t.sprintId === laneId;
    })
    .filter(matchesFilters), sortMode);
}

function refreshLaneCounts() {
  document.querySelectorAll(".sprint-lane[data-lane]").forEach((lane) => {
    const id = lane.dataset.lane;
    const n = tasks.filter((t) => (id === "all" ? true : id === "backlog" ? !t.sprintId : t.sprintId === id)).length;
    const el = lane.querySelector(".lane-count");
    if (el) el.textContent = workItems(n);
  });
}

function refreshColumns() {
  applyLaneFilter();
  refreshLaneCounts();
  if (viewMode === "list") {
    refreshListTables();
    renderBulkBar();
    return;
  }
  document.querySelectorAll(".column").forEach((col) => {
    const status = col.dataset.status;
    const laneId = col.dataset.lane;
    const body = col.querySelector("[data-body]");
    body.innerHTML = "";
    const list = visibleTasks(status, laneId);
    if (list.length === 0) {
      body.innerHTML = `<div class="col-empty">${tl("bd.noTickets")}</div>`;
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
    card.addEventListener("click", (e) => {
      if (e.target.closest(".card-select")) return;
      const t = tasks.find((x) => x.id === card.dataset.id);
      if (t) taskModal(t);
    });
    bindSelectable(card, card.dataset.id);
  });
  renderBulkBar();
}

/* ---------------- Bulk multi-select actions ---------------- */

function renderBulkBar() {
  // Drop selections for tickets that no longer exist locally (deleted, or
  // filtered out by a reload) so the count/bar never lies.
  const known = new Set(tasks.map((t) => t.id));
  for (const id of [...selectedIds]) if (!known.has(id)) selectedIds.delete(id);

  updateSelectGroups();
  const bar = document.getElementById("bulk-bar");
  if (!bar) return;
  if (selectedIds.size === 0) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <span class="bulk-count">${tl("bd.selected", { count: selectedIds.size })}</span>
    <select id="bulk-status">
      <option value="">${tl("bd.moveStatus")}</option>
      ${STATUSES.map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join("")}
    </select>
    <select id="bulk-type">
      <option value="">${tl("bd.changeType")}</option>
      ${TASK_TYPES.map((t) => `<option value="${t}">${TYPE_LABELS[t]}</option>`).join("")}
    </select>
    <select id="bulk-priority">
      <option value="">${tl("bd.changePriority")}</option>
      ${PRIORITIES.map((p) => `<option value="${p}">${PRIORITY_LABELS[p]}</option>`).join("")}
    </select>
    <select id="bulk-assignee">
      <option value="">${tl("bd.assignTo")}</option>
      <option value="__unassign__">${tl("bd.unassigned")}</option>
      ${project.members.map((m) => `<option value="${esc(m.userId)}">${esc(m.name)}${m.userId === state.user.id ? ` ${tl("bd.me")}` : ""}</option>`).join("")}
    </select>
    <button class="btn sm ghost" id="bulk-pdf">${tl("pdf.button")}</button>
    <button class="btn sm danger" id="bulk-delete">${tl("bd.bulkDelete")}</button>
    <button class="btn sm ghost" id="bulk-clear">${tl("bd.clearSel")}</button>`;

  bar.querySelector("#bulk-delete").addEventListener("click", async () => {
    const list = tasks.filter((t) => selectedIds.has(t.id));
    const deleted = await bulkDeleteTickets(list);
    if (!deleted) return;
    for (const id of deleted) { removeLocal(id); selectedIds.delete(id); }
    refreshColumns();
  });
  bar.querySelector("#bulk-status").addEventListener("change", (e) => bulkApply({ status: e.target.value }, e.target));
  bar.querySelector("#bulk-type").addEventListener("change", (e) => bulkApply({ type: e.target.value }, e.target));
  bar.querySelector("#bulk-priority").addEventListener("change", (e) => bulkApply({ priority: e.target.value }, e.target));
  bar.querySelector("#bulk-assignee").addEventListener("change", (e) => {
    bulkApply({ assigneeId: e.target.value === "__unassign__" ? null : e.target.value }, e.target);
  });
  bar.querySelector("#bulk-pdf").addEventListener("click", () => {
    exportTicketsPdf([...selectedIds].map((id) => ({ projectId: project.id, id })));
  });
  bar.querySelector("#bulk-clear").addEventListener("click", () => {
    selectedIds.clear();
    refreshColumns();
    renderBulkBar();
  });
}

async function bulkApply(update, selectEl) {
  const ids = [...selectedIds];
  if (ids.length === 0) return;
  selectEl.disabled = true;
  try {
    const { updated, skipped } = await api.patch("/tasks/bulk", { taskIds: ids, update });
    for (const id of updated) {
      const t = tasks.find((x) => x.id === id);
      if (t) Object.assign(t, update);
    }
    if (updated.length) refreshColumns();
    if (skipped.length === 0) {
      toast(updated.length === 1 ? tl("bd.updated.one") : tl("bd.updated.many", { count: updated.length }), "ok");
    } else {
      toast(tl("bd.updatedSkipped", { updated: updated.length, skipped: skipped.length }), updated.length ? "ok" : "err");
    }
  } catch (err) {
    toast(err.message || tl("bd.bulkFailed"), "err");
  } finally {
    selectEl.value = "";
    selectEl.disabled = false;
  }
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

      // sorted by priority, so a drop position means nothing: only status or sprint can change
      const beforeTaskId = sortMode === "priority" ? undefined : insertionIndex(body, e.clientY, draggedId).beforeTaskId;
      const sameColumn = dragged.status === status;
      if (!sameColumn && !canTransition(dragged.status, status)) {
        toast(tl("bd.illegal", { from: STATUS_LABELS[dragged.status], to: STATUS_LABELS[status] }), "err");
        return;
      }

      // Determine new sprint: moving across lanes changes the sprint assignment.
      const newSprintId = laneId === "all" ? undefined : laneId === "backlog" ? null : laneId;
      const sprintChanged = newSprintId !== undefined && dragged.sprintId !== newSprintId;

      if (sameColumn && !sprintChanged && (sortMode === "priority" || sameColumnOrderUnchanged(dragged, status, beforeTaskId, laneId))) return;

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
      toast(tl("bd.movedTo", { id: task.ticketId, where: STATUS_LABELS[newStatus] }), "ok");
    }
    if (oldSprintId !== task.sprintId) {
      const label = task.sprintId
        ? project.sprints.find((s) => s.id === task.sprintId)?.sprintId ?? tl("bd.sprintFallback")
        : tl("bd.backlog");
      toast(tl("bd.movedTo", { id: task.ticketId, where: label }), "ok");
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
bindTaskModal({
  get project() { return project; },
  get myRole() { return myRole; },
  get tasks() { return tasks; },
  canDeleteTickets, canModifyTask, memberById, parseLabelInput, refreshColumns, removeLocal,
});
export { actText };
