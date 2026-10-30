import { api } from "../api.js";
import { state } from "../main.js";
import { esc, fmtDate, STATUSES, STATUS_LABELS, PRIORITIES, PRIORITY_LABELS, TASK_TYPES, TYPE_LABELS } from "../ui.js";
import { t as tl } from "../i18n.js";
import { openExportDialog, printSections, snapshotPage, withoutAnimation, pdfButton } from "../export-pdf.js";
import { statCardsHtml, ticketRowHtml, projectOverviewTableHtml, sprintBarHtml, activityItemHtml } from "./dashboard/widgets.js";
import { destroyCharts, renderCharts, bindTimeframeToggle } from "./dashboard/charts.js";

let currentStats = null;
let filterOptions = null;
let filterDebounce = null;

const filters = {
  projectId: "",
  sprintId: "",
  assigneeId: "",
  status: "",
  priority: "",
  type: "",
  days: 14,
};

function filtersToQuery() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v) p.set(k, String(v));
  }
  return p.toString();
}

function syncFiltersToUrl() {
  const qs = filtersToQuery();
  const url = qs ? `/dashboard?${qs}` : "/dashboard";
  history.replaceState(null, "", url);
}

function readFiltersFromUrl() {
  const p = new URLSearchParams(location.search);
  filters.projectId = p.get("projectId") || "";
  filters.sprintId = p.get("sprintId") || "";
  filters.assigneeId = p.get("assigneeId") || "";
  filters.status = p.get("status") || "";
  filters.priority = p.get("priority") || "";
  filters.type = p.get("type") || "";
  filters.days = Number(p.get("days")) || 14;
}

function hasActiveFilters() {
  return Object.entries(filters).some(([k, v]) => {
    if (k === "days") return false;
    return v !== "";
  });
}

function clearAllFilters() {
  filters.projectId = "";
  filters.sprintId = "";
  filters.assigneeId = "";
  filters.status = "";
  filters.priority = "";
  filters.type = "";
  filters.days = 14;
}

function buildFilterQueryString() {
  const params = new URLSearchParams();
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.sprintId) params.set("sprintId", filters.sprintId);
  if (filters.assigneeId) params.set("assigneeId", filters.assigneeId);
  if (filters.status) params.set("status", filters.status);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.type) params.set("type", filters.type);
  if (filters.days !== 14) params.set("days", String(filters.days));
  return params.toString();
}

async function fetchStats() {
  const qs = buildFilterQueryString();
  return api.get(`/dashboard/stats${qs ? `?${qs}` : ""}`);
}

export async function renderDashboard(root, override) {
  root.innerHTML = `<div class="page"><div class="spinner"></div></div>`;

  // `override` renders with explicit filters (PDF export) without touching the URL.
  if (override) Object.assign(filters, override);
  else readFiltersFromUrl();

  let stats;
  try {
    stats = await fetchStats();
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }

  currentStats = stats;
  filterOptions = stats.filterOptions;

  const isSuper = state.user.role === "SUPER_ADMIN";
  const isAdmin = state.user.role === "ADMIN" || isSuper;

  destroyCharts();

  root.innerHTML = `
    <div class="page dash-page">
      <div class="page-head">
        <h1>${tl("dash.title")}</h1>
        <span class="spacer" style="flex:1"></span>
        ${pdfButton("dash-pdf")}
        <a class="btn sm ghost" href="/projects" data-nav>${tl("dash.viewProjects")}</a>
      </div>

      ${isSuper ? filterBarHtml() : ""}

      ${statCardsHtml(stats, isSuper)}

      <div class="dash-grid">
        <div class="dash-panel">
          <div class="panel-head">
            <h3>${tl("dash.statusDist")}</h3>
          </div>
          <div class="panel-body chart-wrap chart-short">
            <canvas id="chart-status"></canvas>
          </div>
        </div>

        <div class="dash-panel">
          <div class="panel-head">
            <h3>${tl("dash.myTickets")}</h3>
            <span class="panel-count">${stats.myTickets.length}</span>
          </div>
          <div class="panel-body">
            ${stats.myTickets.length === 0
              ? `<div class="empty-note">${tl("dash.noAssigned")}</div>`
              : `<div class="dash-ticket-list">${stats.myTickets.slice(0, 8).map(ticketRowHtml).join("")}</div>
                 ${stats.myTickets.length > 8 ? `<div class="panel-footer"><a href="/my-tickets" data-nav>${tl("dash.viewAll", { count: stats.myTickets.length })}</a></div>` : ""}`
            }
          </div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="dash-panel">
          <div class="panel-head">
            <h3>${tl("dash.priorityBreakdown")}</h3>
          </div>
          <div class="panel-body chart-wrap chart-short">
            <canvas id="chart-priority"></canvas>
          </div>
        </div>

        <div class="dash-panel">
          <div class="panel-head">
            <h3>${tl("dash.taskTypes")}</h3>
          </div>
          <div class="panel-body chart-wrap chart-short">
            <canvas id="chart-type"></canvas>
          </div>
        </div>
      </div>

      ${isAdmin ? `
      <div class="dash-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head">
            <h3>${tl("dash.createdVsCompleted")}</h3>
            <div class="chart-toggle" id="timeframe-toggle">
              <button class="btn sm ghost active" data-tf="daily">${tl("dash.daily")}</button>
              <button class="btn sm ghost" data-tf="weekly">${tl("dash.weekly")}</button>
            </div>
          </div>
          <div class="panel-body chart-wrap chart-wide">
            <canvas id="chart-timeline"></canvas>
          </div>
        </div>
      </div>` : ""}

      ${isAdmin && (stats.teamWorkload.length > 0 || (isSuper && stats.topAssignees.length > 0)) ? `
      <div class="dash-grid">
        ${isAdmin && stats.teamWorkload.length > 0 ? `
        <div class="dash-panel">
          <div class="panel-head">
            <h3>${tl("dash.teamWorkload")}</h3>
          </div>
          <div class="panel-body chart-wrap chart-tall">
            <canvas id="chart-workload"></canvas>
          </div>
        </div>` : ""}

        ${isSuper && stats.topAssignees.length > 0 ? `
        <div class="dash-panel">
          <div class="panel-head">
            <h3>${tl("dash.topAssignees")}</h3>
          </div>
          <div class="panel-body chart-wrap chart-tall">
            <canvas id="chart-top-assignees"></canvas>
          </div>
        </div>` : ""}
      </div>` : ""}

      ${isAdmin && stats.sprintStats.length > 0 ? `
      <div class="dash-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head">
            <h3>${tl("dash.sprintProgress")}</h3>
          </div>
          <div class="panel-body">
            <div class="sprint-bars">${stats.sprintStats.map(sprintBarHtml).join("")}</div>
          </div>
        </div>
      </div>` : ""}

      ${isAdmin && stats.recentActivity.length > 0 ? `
      <div class="dash-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head">
            <h3>${tl("dash.recentActivity")}</h3>
          </div>
          <div class="panel-body">
            <div class="activity-feed">${stats.recentActivity.map(activityItemHtml).join("")}</div>
          </div>
        </div>
      </div>` : ""}

      <div class="dash-grid hidden" id="gh-activity-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head"><h3>${tl("dash.repoActivity")}</h3></div>
          <div class="panel-body"><ul class="dev-list" id="gh-activity"></ul></div>
        </div>
      </div>

      ${isSuper && stats.projectStats.length > 0 ? `
      <div class="dash-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head">
            <h3>${tl("dash.projectsOverview")}</h3>
          </div>
          <div class="panel-body chart-wrap chart-wide">
            <canvas id="chart-projects"></canvas>
          </div>
          <div class="panel-body">${projectOverviewTableHtml(stats.projectStats)}</div>
        </div>
      </div>` : ""}

      ${isSuper ? `
      <div class="dash-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head">
            <h3>${tl("dash.quickLinks")}</h3>
          </div>
          <div class="panel-body">
            <div class="quick-links">
              <a class="quick-link" href="/admin/users" data-nav>
                <span class="ql-icon">&#9881;</span>
                <span class="ql-label">${tl("dash.manageUsers")}</span>
                <span class="ql-count">${tl("dash.usersCount", { count: stats.totalUsers })}</span>
              </a>
              <a class="quick-link" href="/admin/projects" data-nav>
                <span class="ql-icon">&#128196;</span>
                <span class="ql-label">${tl("dash.manageProjects")}</span>
                <span class="ql-count">${tl("dash.projectsCount", { count: stats.totalProjects })}</span>
              </a>
              <a class="quick-link" href="/admin/settings" data-nav>
                <span class="ql-icon">&#9881;</span>
                <span class="ql-label">${tl("dash.settings")}</span>
              </a>
            </div>
          </div>
        </div>
      </div>` : ""}
    </div>`;

  loadRepoActivity(root);
  renderCharts(stats, isSuper, isAdmin);
  bindTimeframeToggle(stats, isSuper, isAdmin);
  if (isSuper) bindFilterBar();
  root.querySelector("#dash-pdf")?.addEventListener("click", () => openDashboardExport(root, isSuper));
}

/* ---------- GitHub repo activity (hidden unless a project has a linked repo) ---------- */

async function loadRepoActivity(root) {
  let rows;
  try {
    rows = await api.get("/github/activity");
  } catch {
    return;
  }
  const grid = root.querySelector("#gh-activity-grid");
  const list = root.querySelector("#gh-activity");
  if (!grid || !list || rows.length === 0) return;
  list.innerHTML = rows.map((e) => `
    <li class="dev-item">
      <span class="prefix-chip">${esc(e.projectPrefix)}</span>
      <span class="dev-kind">${e.kind === "PR" ? "PR #" + esc(e.ref) : esc(e.ref.slice(0, 7))}</span>
      ${e.kind === "PR" && e.state ? `<span class="dev-state dev-${esc(e.state)}">${esc(e.state)}</span>` : ""}
      ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>` : esc(e.title)}
      <span class="act-when">${esc(e.author || "")} &middot; ${fmtDate(e.updatedAt)}</span>
    </li>`).join("");
  grid.classList.remove("hidden");
}

/* ---------- PDF export ---------- */

// One section per chosen project (or one for "All"). Each is the dashboard rendered with
// those filters, copied as a snapshot; the page is then put back to what the user had.
function openDashboardExport(root, isSuper) {
  const opts = filterOptions || { projects: [], users: [] };
  const fields = [{
    key: "projects", kind: "multi", label: tl("pdf.projects"),
    options: opts.projects.map((p) => ({ value: p.id, label: `${p.prefix} - ${p.name}` })),
  }];
  if (isSuper) {
    fields.push(
      { key: "assigneeId", kind: "single", label: tl("pdf.assignee"), value: filters.assigneeId, options: opts.users.map((u) => ({ value: u.id, label: u.name })) },
      { key: "status", kind: "single", label: tl("pdf.status"), value: filters.status, options: STATUSES.map((v) => ({ value: v, label: STATUS_LABELS[v] })) },
      { key: "priority", kind: "single", label: tl("pdf.priority"), value: filters.priority, options: PRIORITIES.map((v) => ({ value: v, label: PRIORITY_LABELS[v] })) },
      { key: "type", kind: "single", label: tl("pdf.type"), value: filters.type, options: TASK_TYPES.map((v) => ({ value: v, label: TYPE_LABELS[v] })) },
      { key: "days", kind: "single", noAll: true, label: tl("pdf.range"), value: String(filters.days), options: [7, 14, 30, 60, 90].map((n) => ({ value: String(n), label: tl("dash.f.days", { count: n }) })) },
    );
  }
  openExportDialog({
    title: tl("pdf.title"),
    fields,
    onExport: async (v) => {
      const variants = v.projects ?? [""];
      const base = isSuper
        ? { assigneeId: v.assigneeId, status: v.status, priority: v.priority, type: v.type, days: Number(v.days) || 14 }
        : {};
      const sections = [];
      try {
        await withoutAnimation(async () => {
          for (const projectId of variants) {
            await renderDashboard(root, { ...base, projectId, sprintId: "" });
            const p = opts.projects.find((x) => x.id === projectId);
            sections.push({ title: p ? `${p.prefix} - ${p.name}` : tl("pdf.allProjects"), html: snapshotPage(root) });
          }
        });
      } finally {
        await renderDashboard(root);
      }
      await printSections(tl("pdf.doc.dashboard"), sections, v.paper);
    },
  });
}

/* ---------- Filter bar ---------- */

function filterBarHtml() {
  const opts = filterOptions || { projects: [], sprints: [], users: [] };
  return `
  <div class="filter-bar" id="filter-bar">
    <div class="filter-row">
      <div class="filter-group">
        <label class="filter-label">${tl("dash.f.project")}</label>
        <select id="f-project" class="filter-select">
          <option value="">${tl("dash.f.allProjects")}</option>
          ${opts.projects.map((p) => `<option value="${esc(p.id)}" ${filters.projectId === p.id ? "selected" : ""}>${esc(p.prefix)} - ${esc(p.name)}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">${tl("dash.f.sprint")}</label>
        <select id="f-sprint" class="filter-select">
          <option value="">${tl("dash.f.allSprints")}</option>
          ${opts.sprints.map((s) => `<option value="${esc(s.id)}" ${filters.sprintId === s.id ? "selected" : ""}>${esc(s.sprintId)} - ${esc(s.name)}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">${tl("dash.f.assignee")}</label>
        <select id="f-assignee" class="filter-select">
          <option value="">${tl("dash.f.anyone")}</option>
          ${opts.users.map((u) => `<option value="${esc(u.id)}" ${filters.assigneeId === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">${tl("dash.f.status")}</label>
        <select id="f-status" class="filter-select">
          <option value="">${tl("dash.f.anyStatus")}</option>
          ${STATUSES.map((s) => `<option value="${esc(s)}" ${filters.status === s ? "selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">${tl("dash.f.priority")}</label>
        <select id="f-priority" class="filter-select">
          <option value="">${tl("dash.f.anyPriority")}</option>
          ${PRIORITIES.map((p) => `<option value="${esc(p)}" ${filters.priority === p ? "selected" : ""}>${PRIORITY_LABELS[p]}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">${tl("dash.f.type")}</label>
        <select id="f-type" class="filter-select">
          <option value="">${tl("dash.f.allTypes")}</option>
          ${TASK_TYPES.map((t) => `<option value="${esc(t)}" ${filters.type === t ? "selected" : ""}>${TYPE_LABELS[t]}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">${tl("dash.f.range")}</label>
        <select id="f-days" class="filter-select filter-select-sm">
          <option value="7" ${filters.days === 7 ? "selected" : ""}>${tl("dash.f.days", { count: 7 })}</option>
          <option value="14" ${filters.days === 14 ? "selected" : ""}>${tl("dash.f.days", { count: 14 })}</option>
          <option value="30" ${filters.days === 30 ? "selected" : ""}>${tl("dash.f.days", { count: 30 })}</option>
          <option value="60" ${filters.days === 60 ? "selected" : ""}>${tl("dash.f.days", { count: 60 })}</option>
          <option value="90" ${filters.days === 90 ? "selected" : ""}>${tl("dash.f.days", { count: 90 })}</option>
        </select>
      </div>
      ${hasActiveFilters() ? `
      <div class="filter-group filter-actions">
        <button class="btn sm ghost" id="f-clear" title="${tl("dash.f.clearTitle")}">${tl("dash.f.clear")}</button>
      </div>` : ""}
    </div>
    ${hasActiveFilters() ? activeFilterChipsHtml() : ""}
  </div>`;
}

function activeFilterChipsHtml() {
  const chips = [];
  if (filters.projectId) {
    const p = filterOptions?.projects.find((x) => x.id === filters.projectId);
    chips.push(chipHtml("project", p ? `${p.prefix} - ${p.name}` : filters.projectId));
  }
  if (filters.sprintId) {
    const s = filterOptions?.sprints.find((x) => x.id === filters.sprintId);
    chips.push(chipHtml("sprint", s ? `${s.sprintId}` : filters.sprintId));
  }
  if (filters.assigneeId) {
    const u = filterOptions?.users.find((x) => x.id === filters.assigneeId);
    chips.push(chipHtml("assignee", u ? u.name : filters.assigneeId));
  }
  if (filters.status) chips.push(chipHtml("status", STATUS_LABELS[filters.status]));
  if (filters.priority) chips.push(chipHtml("priority", PRIORITY_LABELS[filters.priority]));
  if (filters.type) chips.push(chipHtml("type", TYPE_LABELS[filters.type]));
  if (chips.length === 0) return "";
  return `<div class="filter-chips">${chips.join("")}</div>`;
}

function chipHtml(key, label) {
  return `<span class="filter-chip" data-clear="${key}">
    ${esc(label)}
    <button class="chip-x" data-clear="${key}" title="${tl("dash.f.remove")}">&times;</button>
  </span>`;
}

function bindFilterBar() {
  const bar = document.getElementById("filter-bar");
  if (!bar) return;

  const selects = {
    projectId: bar.querySelector("#f-project"),
    sprintId: bar.querySelector("#f-sprint"),
    assigneeId: bar.querySelector("#f-assignee"),
    status: bar.querySelector("#f-status"),
    priority: bar.querySelector("#f-priority"),
    type: bar.querySelector("#f-type"),
    days: bar.querySelector("#f-days"),
  };

  const applyFilter = (key, value) => {
    filters[key] = value;
    if (key === "projectId") {
      filters.sprintId = "";
    }
    syncFiltersToUrl();
    debouncedReload();
  };

  for (const [key, el] of Object.entries(selects)) {
    if (!el) continue;
    el.addEventListener("change", () => applyFilter(key, el.value));
  }

  // Clear button
  const clearBtn = bar.querySelector("#f-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearAllFilters();
      syncFiltersToUrl();
      reloadDashboard();
    });
  }

  // Chip remove buttons
  bar.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.clear;
      if (key === "project") { filters.projectId = ""; filters.sprintId = ""; }
      else if (key === "sprint") filters.sprintId = "";
      else if (key === "assignee") filters.assigneeId = "";
      else if (key === "status") filters.status = "";
      else if (key === "priority") filters.priority = "";
      else if (key === "type") filters.type = "";
      syncFiltersToUrl();
      reloadDashboard();
    });
  });
}

function debouncedReload() {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(reloadDashboard, 300);
}

async function reloadDashboard() {
  const root = document.getElementById("page");
  if (!root) return;
  destroyCharts();
  await renderDashboard(root);
}

/* ---------- Stat cards ---------- */
