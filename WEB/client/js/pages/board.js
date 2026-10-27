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

/* ---------------- Task modal ---------------- */

function assigneeOptions(selectedId) {
  return [`<option value="">${tl("bd.unassigned")}</option>`]
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
      ? tl("bd.newTicketTitle")
      : `<span class="ticket-path">${esc(project.name)} / ${esc(project.sprints.find((x) => x.id === task.sprintId)?.sprintId ?? tl("bd.backlog"))} /</span> <span class="ticket-id">${esc(task.ticketId)}</span> ${mayEdit ? tl("bd.editTicket") : tl("bd.ticketDetails")}`,
    body: `
      <div id="task-error" class="form-error hidden"></div>
      <form id="task-form">
        <div class="task-grid">
          <div class="task-left">
            <div class="field">
              <label for="tf-title">${tl("bd.fTitle")}</label>
              <input id="tf-title" type="text" required ${dis} value="${isEdit ? esc(task.title) : ""}" />
            </div>
            <div class="field">
              <label for="tf-desc">${tl("bd.fDescription")}</label>
              ${mayEdit ? `
              <div class="rte-toolbar" id="tf-desc-toolbar">
                <button type="button" data-cmd="bold" title="${tl("bd.bold")}"><b>B</b></button>
                <button type="button" data-cmd="italic" title="${tl("bd.italic")}"><i>I</i></button>
                <button type="button" data-cmd="underline" title="${tl("bd.underline")}"><u>U</u></button>
                <button type="button" data-cmd="strikeThrough" title="${tl("bd.strike")}"><s>S</s></button>
                <span class="rte-sep"></span>
                <button type="button" data-block="h2" title="${tl("bd.heading")}">H2</button>
                <button type="button" data-block="h3" title="${tl("bd.subheading")}">H3</button>
                <button type="button" data-block="p" title="${tl("bd.paragraph")}">&para;</button>
                <span class="rte-sep"></span>
                <button type="button" data-cmd="insertUnorderedList" title="${tl("bd.bullets")}">&bull; &#8801;</button>
                <button type="button" data-cmd="insertOrderedList" title="${tl("bd.numbers")}">1. &#8801;</button>
                <span class="rte-sep"></span>
                <button type="button" id="tf-link" title="${tl("bd.insLink")}">&#128279;</button>
                <button type="button" id="tf-code" title="${tl("bd.codeBlock")}">&lt;/&gt;</button>
                <button type="button" id="tf-image" title="${tl("bd.insImage")}">&#128444;</button>
                <button type="button" id="tf-video" title="${tl("bd.insVideo")}">&#127916;</button>
                <span class="rte-sep"></span>
                <button type="button" data-cmd="removeFormat" title="${tl("bd.clearFmt")}">&#10539;</button>
              </div>` : ""}
              <input type="file" id="tf-media-input" hidden />
              <div id="tf-desc" class="rte" contenteditable="${mayEdit}" aria-label="${tl("bd.fDescription")}">${descToEditorHtml(isEdit ? task.description : "")}</div>
            </div>
            <div class="modal-actions">
              ${isEdit && mayEdit && canDeleteTickets() ? `<button type="button" class="btn danger" id="tf-delete">${tl("bd.delete")}</button>` : ""}
              ${isEdit ? `<button type="button" class="btn ghost" id="tf-pdf" title="${tl("pdf.title")}">${tl("pdf.button")}</button>` : ""}
              ${isEdit && myRole === "ADMIN" ? `<button type="button" class="btn ghost" id="tf-share-toggle">${tl("bd.share")}</button>` : ""}
              ${!mayEdit ? `<span class="ro-note">${tl("bd.readOnly")}</span>` : ""}
              <span id="tf-savestate" class="save-state"></span>
              <span class="right">
                ${mayEdit ? `<button type="submit" class="btn" id="tf-save">${isEdit ? tl("bd.save") : tl("bd.createTicket")}</button>` : ""}
                <button type="button" class="btn ghost" data-close>${isEdit ? tl("bd.close") : tl("bd.cancel")}</button>
              </span>
            </div>
            ${isEdit && myRole === "ADMIN" ? `<div class="share-panel hidden" id="tf-share-panel"></div>` : ""}
            ${isEdit ? `<div class="dev-panel hidden" id="tf-dev"></div>` : ""}
            ${isEdit ? `
            <div class="comments-block">
              <div class="activity-head">${tl("bd.comments")}</div>
              <div class="comment-box">
                <div class="comment-rte-wrap">
                  <div class="rte-toolbar" id="tf-comment-toolbar">
                    <button type="button" data-cmd="bold" title="${tl("bd.bold")}"><b>B</b></button>
                    <button type="button" data-cmd="italic" title="${tl("bd.italic")}"><i>I</i></button>
                    <button type="button" data-cmd="underline" title="${tl("bd.underline")}"><u>U</u></button>
                    <button type="button" data-cmd="strikeThrough" title="${tl("bd.strike")}"><s>S</s></button>
                    <span class="rte-sep"></span>
                    <button type="button" data-block="h2" title="${tl("bd.heading")}">H2</button>
                    <button type="button" data-block="h3" title="${tl("bd.subheading")}">H3</button>
                    <button type="button" data-block="p" title="${tl("bd.paragraph")}">&para;</button>
                    <span class="rte-sep"></span>
                    <button type="button" data-cmd="insertUnorderedList" title="${tl("bd.bullets")}">&bull; &#8801;</button>
                    <button type="button" data-cmd="insertOrderedList" title="${tl("bd.numbers")}">1. &#8801;</button>
                    <span class="rte-sep"></span>
                    <button type="button" id="tf-comment-link" title="${tl("bd.insLink")}">&#128279;</button>
                    <button type="button" id="tf-comment-code" title="${tl("bd.codeBlock")}">&lt;/&gt;</button>
                    <button type="button" id="tf-comment-image" title="${tl("bd.insImage")}">&#128444;</button>
                    <button type="button" id="tf-comment-video" title="${tl("bd.insVideo")}">&#127916;</button>
                    <span class="rte-sep"></span>
                    <button type="button" data-cmd="removeFormat" title="${tl("bd.clearFmt")}">&#10539;</button>
                  </div>
                  <input type="file" id="tf-comment-media-input" hidden />
                  <div id="tf-comment-input" class="rte comment-rte" contenteditable="true" data-placeholder="${tl("bd.commentPh")}"></div>
                </div>
                <button type="button" class="btn sm" id="tf-comment-send">${tl("bd.send")}</button>
                <div id="tf-mention-menu" class="mention-menu hidden"></div>
              </div>
              <ol id="tf-comments" class="comment-list"><li class="act-empty">${tl("bd.loading")}</li></ol>
            </div>` : ""}
          </div>
          <div class="task-right">
            <div class="detail-card">
              <div class="detail-row">
                <span class="k">${tl("bd.dProject")}</span>
                <span class="v">${esc(project.name)}&nbsp;<span class="prefix-chip">${esc(project.prefix)}</span></span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">${tl("bd.dTicketId")}</span>
                <span class="v"><span class="ticket-id">${esc(task.ticketId)}</span></span>
              </div>` : ""}
              <div class="detail-row">
                <span class="k">${tl("bd.dType")}${isEdit && myRole !== "ADMIN" ? ` ${tl("bd.adminOnly")}` : ""}</span>
                <span class="v">
                  <select id="tf-type" ${!isEdit || myRole === "ADMIN" ? dis : "disabled"}>
                    ${TASK_TYPES.map((v) => `<option value="${v}" ${v === (isEdit ? task.type : "TASK") ? "selected" : ""}>${TYPE_LABELS[v]}</option>`).join("")}
                  </select>
                </span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">${tl("bd.dBranch")}</span>
                <span class="v"><code class="branch-chip" id="tf-branch" title="${tl("bd.copyBranch")}">${esc(branchName(task))}</code></span>
              </div>` : ""}
              <div class="detail-row">
                <span class="k">${tl("bd.dPriority")}${isEdit && myRole !== "ADMIN" ? ` ${tl("bd.adminOnly")}` : ""}</span>
                <span class="v">
                  <select id="tf-priority" ${!isEdit || myRole === "ADMIN" ? dis : "disabled"}>
                    ${PRIORITIES.map((v) => `<option value="${v}" ${v === (isEdit ? task.priority : "MEDIUM") ? "selected" : ""}>${PRIORITY_LABELS[v]}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dStatus")}</span>
                <span class="v">
                  <select id="tf-status" ${dis}>
                    ${(isEdit ? allowedTargetList(task.status) : STATUSES.map((s) => ({ value: s }))).map(({ value, label }) =>
                      `<option value="${esc(value)}" ${value === (isEdit ? task.status : presetStatus) ? "selected" : ""}>${esc(label || STATUS_LABELS[value])}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dLabels")}</span>
                <span class="v">
                  <input type="text" id="tf-labels" ${dis} placeholder="${tl("bd.labelsPh")}" maxlength="340" value="${isEdit ? esc((task.labels || []).join(", ")) : ""}" />
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dDue")}</span>
                <span class="v">
                  <input type="date" id="tf-due" ${dis} value="${isEdit && task.dueDate ? esc(task.dueDate) : ""}" />
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dSprint")}</span>
                <span class="v">
                  <select id="tf-sprint" ${dis}>
                    <option value="">${tl("bd.noSprint")}</option>
                    ${project.sprints.map((s) => `<option value="${esc(s.id)}" ${(isEdit ? task.sprintId : presetSprintId) === s.id ? "selected" : ""}>${esc(s.sprintId)} &mdash; ${esc(s.name)}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dAssignee")}${isEdit && mayEdit && myRole !== "ADMIN" ? ` ${tl("bd.adminOnly")}` : ""}</span>
                <span class="v">
                  <select id="tf-assignee" ${mayEdit && (myRole === "ADMIN" || !isEdit) ? "" : "disabled"}>${assigneeOptions(isEdit ? task.assigneeId : "")}</select>
                </span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">${tl("bd.dCreatedBy")}</span>
                <span class="v">${creator ? `${avatarHtml(creator.name, creator.userId)} ${esc(creator.name)}` : "&mdash;"}</span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dCreated")}</span>
                <span class="v">${fmtDate(task.createdAt)}</span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dUpdated")}</span>
                <span class="v">${fmtDate(task.updatedAt)}</span>
              </div>` : ""}
            </div>
            ${isEdit ? `
            <div class="detail-card activity-card">
              <div class="activity-head">${tl("bd.activity")}</div>
              <ol id="tf-activity" class="activity-list"><li class="act-empty">${tl("bd.loading")}</li></ol>
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
          s === "saving" ? tl("bd.saving") :
          s === "saved" ? tl("bd.allSaved") :
          s === "error" ? (msg || tl("bd.saveFailed")) :
          s === "draft" ? tl("bd.startTyping") : "";
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
          labels: pendingDraft.labels || [],
          dueDate: pendingDraft.dueDate || null,
        };
        const createdTask = await api.post(`/projects/${project.id}/tasks`, payload);
        created = true;
        taskRef = createdTask;
        tasks.push(createdTask);
        const h = modalEl.querySelector(".modal-head h2");
        if (h) h.innerHTML = `<span class="ticket-id">${esc(createdTask.ticketId)}</span> Edit ticket`;
        setSaveState("saved");
        refreshColumns();
        toast(tl("bd.ticketCreated", { id: createdTask.ticketId }), "ok");
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
        payload.labels = parseLabelInput(form.querySelector("#tf-labels").value);
        payload.dueDate = form.querySelector("#tf-due").value || null;
        if (isEdit) payload.status = form.querySelector("#tf-status").value;

        if (created) {
          setSaveState("saving");
          const updated = await api.patch(`/projects/${project.id}/tasks/${taskRef.id}`, payload);
          Object.assign(taskRef, updated);
          setSaveState("saved");
          refreshColumns();
          toast(tl("bd.ticketSaved", { id: taskRef.ticketId }), "ok");
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
          toast(tl("bd.ticketCreated", { id: createdTask.ticketId }), "ok");
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
            .then(() => toast(tl("bd.branchCopied"), "ok"))
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
          toast(tl("bd.uploading", { name: file.name }));
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
            toast(tl("bd.added", { name: file.name }), "ok");
          } catch (err) {
            toast(err.message || tl("bd.uploadFailed"), "err");
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
        const labelsInput = modalEl.querySelector("#tf-labels");
        if (labelsInput && !labelsInput.disabled) labelsInput.addEventListener("change", () => commit({ labels: parseLabelInput(labelsInput.value) }));
        const dueInput = modalEl.querySelector("#tf-due");
        if (dueInput && !dueInput.disabled) dueInput.addEventListener("change", () => commit({ dueDate: dueInput.value || null }));
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

      if (isEdit && myRole === "ADMIN") setupSharePanel(modalEl, task);
      if (isEdit) loadDevPanel(modalEl, task);
      modalEl.querySelector("#tf-pdf")?.addEventListener("click", () => exportTicketsPdf([{ projectId: project.id, id: task.id }]));
      const delBtn = modalEl.querySelector("#tf-delete");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          if (!confirm(tl("bd.deleteConfirm", { id: task.ticketId }))) return;
          delBtn.disabled = true;
          try {
            await api.del(`/projects/${project.id}/tasks/${task.id}`);
            removeLocal(task.id);
            close();
            refreshColumns();
            toast(tl("bd.ticketDeleted", { id: task.ticketId }), "ok");
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

export function actText(ev) {
  const arrow = `<span class="act-arrow">&rarr;</span>`;
  switch (ev.type) {
    case "CREATED":
      return ev.newStatus ? tl("bd.a.createdAs", { status: statusPill(ev.newStatus, undefined, true) }) : tl("bd.a.created");
    case "STATUS_CHANGED":
      return tl("bd.a.moved", { from: statusPill(ev.oldStatus, undefined, true), to: statusPill(ev.newStatus, undefined, true) }).replace("→", arrow);
    case "TITLE_CHANGED":
      return tl("bd.a.renamed", { from: `<del class="act-old">${esc(truncate(ev.oldValue, 80))}</del>`, to: `<b>${esc(truncate(ev.newValue, 80))}</b>` }).replace("→", arrow);
    case "DESCRIPTION_CHANGED": {
      let t = tl("bd.a.desc");
      const prev = truncate(ev.newValue, 120);
      if (prev) t += `<div class="act-quote">${esc(prev)}</div>`;
      return t;
    }
    case "ASSIGNEE_CHANGED":
      return tl("bd.a.assignee", { from: `<b>${esc(ev.oldValue || tl("bd.unassigned"))}</b>`, to: `<b>${esc(ev.newValue || tl("bd.unassigned"))}</b>` }).replace("→", arrow);
    case "SPRINT_CHANGED":
      return tl("bd.a.sprint", { from: `<b>${esc(ev.oldValue || tl("bd.backlog"))}</b>`, to: `<b>${esc(ev.newValue || tl("bd.backlog"))}</b>` }).replace("→", arrow);
    default:
      return esc(String(ev.type || "").toLowerCase().replaceAll("_", " "));
  }
}

function activityItemHtml(ev) {
  const who = ev.actorName || tl("bd.someone");
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
        : `<li class="act-empty">${tl("bd.noActivity")}</li>`;
    })
    .catch(() => {
      listEl.innerHTML = `<li class="act-empty">${tl("bd.activityFailed")}</li>`;
    });
}

/* ---------- Development (GitHub commits / PRs, optional branch creation) ---------- */

const PR_STATE_LABEL = labels("bd.pr", ["open", "draft", "closed", "merged"]);

async function loadDevPanel(modalEl, task) {
  const panel = modalEl.querySelector("#tf-dev");
  if (!panel) return;
  let info;
  try {
    info = await api.get(`/projects/${project.id}/tasks/${task.id}/github`);
  } catch {
    return;
  }
  if (!info.repo) return;
  const render = (inf) => {
    panel.classList.remove("hidden");
    const rows = inf.events.map((e) => `
      <li class="dev-item">
        <span class="dev-kind">${e.kind === "PR" ? "PR #" + esc(e.ref) : esc(e.ref.slice(0, 7))}</span>
        ${e.kind === "PR" && e.state ? `<span class="dev-state dev-${esc(e.state)}">${esc(PR_STATE_LABEL[e.state] || e.state)}</span>` : ""}
        ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>` : esc(e.title)}
        <span class="act-when">${esc(e.author || "")} &middot; ${fmtDate(e.updatedAt)}</span>
      </li>`).join("");
    panel.innerHTML = `
      <div class="dev-head">
        <h3>${tl("bd.development")}</h3>
        <span class="share-note">${esc(inf.repo)}</span>
        <a href="/projects/${encodeURIComponent(project.id)}/graph" data-nav class="share-note">${tl("bd.viewGraph")}</a>
        ${inf.branchEnabled ? `<button type="button" class="btn sm ghost" id="dev-branch">Create branch ${esc(inf.branchName)}</button>` : ""}
      </div>
      <ul class="dev-list">${rows || `<li class="act-empty">${tl("bd.noDev", { id: `<b>${esc(task.ticketId)}</b>` })}</li>`}</ul>`;
    panel.querySelector("#dev-branch")?.addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api.post(`/projects/${project.id}/tasks/${task.id}/github/branch`, {});
        toast(tl(r.created ? "bd.branchCreated" : "bd.branchExists", { name: r.branch }), "ok");
      } catch (err) {
        toast(err.message || tl("bd.branchFailed"), "err");
      } finally {
        ev.target.disabled = false;
      }
    });
  };
  render(info);
}

/* ---------- Sharing (project admins only; single ticket, revocable) ---------- */

function setupSharePanel(modalEl, task) {
  const toggle = modalEl.querySelector("#tf-share-toggle");
  const panel = modalEl.querySelector("#tf-share-panel");
  if (!toggle || !panel) return;
  const base = `/projects/${project.id}/tasks/${task.id}/share`;
  let loaded = false;

  const render = (st) => {
    const url = st.token ? `${location.origin}/share/${st.token}` : "";
    panel.innerHTML = `
      <label class="share-row">${tl("bd.sh.who")}
        <select id="share-mode">
          <option value="OFF"${st.mode === "OFF" ? " selected" : ""}>${tl("bd.sh.off")}</option>
          <option value="ACCOUNT"${st.mode === "ACCOUNT" ? " selected" : ""}>${tl("bd.sh.account")}</option>
          <option value="LINK"${st.mode === "LINK" ? " selected" : ""}>${tl("bd.sh.link")}</option>
        </select>
      </label>
      ${url ? `
      <div class="share-row">
        <input type="text" id="share-url" readonly value="${esc(url)}" />
        <button type="button" class="btn sm" id="share-copy">${tl("bd.sh.copy")}</button>
        <button type="button" class="btn sm ghost" id="share-rotate" title="${tl("bd.sh.rotateTitle")}">${tl("bd.sh.rotate")}</button>
      </div>
      <p class="share-note">${tl("bd.sh.note")}</p>` : ""}`;
    panel.querySelector("#share-mode").addEventListener("change", (e) => save({ mode: e.target.value }));
    panel.querySelector("#share-copy")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); toast(tl("bd.linkCopied"), "ok"); }
      catch { panel.querySelector("#share-url").select(); }
    });
    panel.querySelector("#share-rotate")?.addEventListener("click", () => {
      if (confirm(tl("bd.sh.confirmRotate"))) save({ mode: st.mode, regenerate: true });
    });
  };

  const save = async (body) => {
    try {
      const st = await api.put(base, body);
      task.shareMode = st.mode;
      render(st);
      toast(tl(st.mode === "OFF" ? "bd.sh.revoked" : "bd.sh.updated"), "ok");
    } catch (err) {
      toast(err.message || tl("bd.sh.failed"), "err");
    }
  };

  toggle.addEventListener("click", async () => {
    panel.classList.toggle("hidden");
    if (panel.classList.contains("hidden") || loaded) return;
    try {
      render(await api.get(base));
      loaded = true;
    } catch (err) {
      panel.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    }
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
  const who = c.authorName || tl("bd.unknown");
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
    toast(tl("bd.uploading", { name: file.name }));
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
      toast(tl("bd.added", { name: file.name }), "ok");
    } catch (err) {
      toast(err.message || tl("bd.uploadFailed"), "err");
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
          : `<li class="act-empty">${tl("bd.noComments")}</li>`;
      })
      .catch(() => { listEl.innerHTML = `<li class="act-empty">${tl("bd.commentsFailed")}</li>`; });
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
      toast(err.message || tl("bd.commentFailed"), "err");
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
