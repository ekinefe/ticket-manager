import { api } from "../api.js";
import { state, navigate } from "../main.js";
import {
  esc, avatarHtml, statusPill, priorityPill, roleChip, fmtDate,
  STATUSES, STATUS_LABELS, getStatusColor,
  PRIORITIES, PRIORITY_LABELS, getPriorityColor,
  TASK_TYPES, TYPE_LABELS,
} from "../ui.js";

let charts = {};
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

export async function renderDashboard(root) {
  root.innerHTML = `<div class="page"><div class="spinner"></div></div>`;

  readFiltersFromUrl();

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
        <h1>Dashboard</h1>
        <span class="spacer" style="flex:1"></span>
        <a class="btn sm ghost" href="/projects" data-nav>View Projects</a>
      </div>

      ${isSuper ? filterBarHtml() : ""}

      ${statCardsHtml(stats, isSuper)}

      <div class="dash-grid">
        <div class="dash-panel">
          <div class="panel-head">
            <h3>Status Distribution</h3>
          </div>
          <div class="panel-body chart-wrap chart-short">
            <canvas id="chart-status"></canvas>
          </div>
        </div>

        <div class="dash-panel">
          <div class="panel-head">
            <h3>My Tickets</h3>
            <span class="panel-count">${stats.myTickets.length}</span>
          </div>
          <div class="panel-body">
            ${stats.myTickets.length === 0
              ? `<div class="empty-note">No tickets assigned to you.</div>`
              : `<div class="dash-ticket-list">${stats.myTickets.slice(0, 8).map(ticketRowHtml).join("")}</div>
                 ${stats.myTickets.length > 8 ? `<div class="panel-footer"><a href="/my-tickets" data-nav>View all ${stats.myTickets.length} tickets</a></div>` : ""}`
            }
          </div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="dash-panel">
          <div class="panel-head">
            <h3>Priority Breakdown</h3>
          </div>
          <div class="panel-body chart-wrap chart-short">
            <canvas id="chart-priority"></canvas>
          </div>
        </div>

        <div class="dash-panel">
          <div class="panel-head">
            <h3>Task Types</h3>
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
            <h3>Created vs Completed</h3>
            <div class="chart-toggle" id="timeframe-toggle">
              <button class="btn sm ghost active" data-tf="daily">Daily</button>
              <button class="btn sm ghost" data-tf="weekly">Weekly</button>
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
            <h3>Team Workload</h3>
          </div>
          <div class="panel-body chart-wrap chart-tall">
            <canvas id="chart-workload"></canvas>
          </div>
        </div>` : ""}

        ${isSuper && stats.topAssignees.length > 0 ? `
        <div class="dash-panel">
          <div class="panel-head">
            <h3>Top Assignees</h3>
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
            <h3>Sprint Progress</h3>
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
            <h3>Recent Activity</h3>
          </div>
          <div class="panel-body">
            <div class="activity-feed">${stats.recentActivity.map(activityItemHtml).join("")}</div>
          </div>
        </div>
      </div>` : ""}

      ${isSuper && stats.projectStats.length > 0 ? `
      <div class="dash-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head">
            <h3>Projects Overview</h3>
          </div>
          <div class="panel-body chart-wrap chart-wide">
            <canvas id="chart-projects"></canvas>
          </div>
        </div>
      </div>` : ""}

      ${isSuper ? `
      <div class="dash-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head">
            <h3>Quick Links</h3>
          </div>
          <div class="panel-body">
            <div class="quick-links">
              <a class="quick-link" href="/admin/users" data-nav>
                <span class="ql-icon">&#9881;</span>
                <span class="ql-label">Manage Users</span>
                <span class="ql-count">${stats.totalUsers} users</span>
              </a>
              <a class="quick-link" href="/admin/projects" data-nav>
                <span class="ql-icon">&#128196;</span>
                <span class="ql-label">Manage Projects</span>
                <span class="ql-count">${stats.totalProjects} projects</span>
              </a>
              <a class="quick-link" href="/admin/settings" data-nav>
                <span class="ql-icon">&#9881;</span>
                <span class="ql-label">Settings</span>
              </a>
            </div>
          </div>
        </div>
      </div>` : ""}
    </div>`;

  renderCharts(stats, isSuper, isAdmin);
  bindTimeframeToggle(stats, isSuper, isAdmin);
  if (isSuper) bindFilterBar();
}

/* ---------- Filter bar ---------- */

function filterBarHtml() {
  const opts = filterOptions || { projects: [], sprints: [], users: [] };
  return `
  <div class="filter-bar" id="filter-bar">
    <div class="filter-row">
      <div class="filter-group">
        <label class="filter-label">Project</label>
        <select id="f-project" class="filter-select">
          <option value="">All projects</option>
          ${opts.projects.map((p) => `<option value="${esc(p.id)}" ${filters.projectId === p.id ? "selected" : ""}>${esc(p.prefix)} - ${esc(p.name)}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">Sprint</label>
        <select id="f-sprint" class="filter-select">
          <option value="">All sprints</option>
          ${opts.sprints.map((s) => `<option value="${esc(s.id)}" ${filters.sprintId === s.id ? "selected" : ""}>${esc(s.sprintId)} - ${esc(s.name)}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">Assignee</label>
        <select id="f-assignee" class="filter-select">
          <option value="">Anyone</option>
          ${opts.users.map((u) => `<option value="${esc(u.id)}" ${filters.assigneeId === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">Status</label>
        <select id="f-status" class="filter-select">
          <option value="">Any status</option>
          ${STATUSES.map((s) => `<option value="${esc(s)}" ${filters.status === s ? "selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">Priority</label>
        <select id="f-priority" class="filter-select">
          <option value="">Any priority</option>
          ${PRIORITIES.map((p) => `<option value="${esc(p)}" ${filters.priority === p ? "selected" : ""}>${PRIORITY_LABELS[p]}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">Type</label>
        <select id="f-type" class="filter-select">
          <option value="">All types</option>
          ${TASK_TYPES.map((t) => `<option value="${esc(t)}" ${filters.type === t ? "selected" : ""}>${TYPE_LABELS[t]}</option>`).join("")}
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">Range</label>
        <select id="f-days" class="filter-select filter-select-sm">
          <option value="7" ${filters.days === 7 ? "selected" : ""}>7 days</option>
          <option value="14" ${filters.days === 14 ? "selected" : ""}>14 days</option>
          <option value="30" ${filters.days === 30 ? "selected" : ""}>30 days</option>
          <option value="60" ${filters.days === 60 ? "selected" : ""}>60 days</option>
          <option value="90" ${filters.days === 90 ? "selected" : ""}>90 days</option>
        </select>
      </div>
      ${hasActiveFilters() ? `
      <div class="filter-group filter-actions">
        <button class="btn sm ghost" id="f-clear" title="Clear all filters">Clear filters</button>
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
    <button class="chip-x" data-clear="${key}" title="Remove">&times;</button>
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

function statCardsHtml(stats, isSuper) {
  if (isSuper) {
    return `
    <div class="stat-cards">
      <div class="stat-card">
        <div class="stat-value">${stats.totalTickets}</div>
        <div class="stat-label">Total Tickets</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.totalProjects}</div>
        <div class="stat-label">Projects</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.totalUsers}</div>
        <div class="stat-label">Users</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.myTickets.length}</div>
        <div class="stat-label">My Tickets</div>
      </div>
    </div>`;
  }

  return `
  <div class="stat-cards">
    <div class="stat-card">
      <div class="stat-value">${stats.totalTickets}</div>
      <div class="stat-label">Total Tickets</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.myProjects.length}</div>
      <div class="stat-label">My Projects</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.myTickets.length}</div>
      <div class="stat-label">My Tickets</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.statusCounts["DONE"] || 0}</div>
      <div class="stat-label">Completed</div>
    </div>
  </div>`;
}

/* ---------- Ticket / sprint / activity rows ---------- */

function ticketRowHtml(t) {
  return `
  <a class="dash-ticket" href="/projects/${encodeURIComponent(t.projectId)}" data-nav>
    <span class="ticket-id">${esc(t.ticketId)}</span>
    <span class="dt-title">${esc(t.title)}</span>
    <span class="dt-meta">
      ${priorityPill(t.priority)}
      <span class="prefix-chip sm">${esc(t.projectPrefix)}</span>
    </span>
  </a>`;
}

function sprintBarHtml(s) {
  const total = Number(s.total);
  const done = Number(s.done);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `
  <div class="sprint-bar">
    <div class="sb-head">
      <span class="ticket-id">${esc(s.sprintId)}</span>
      <span class="sb-name">${esc(s.name)}</span>
      <span class="sb-meta">${esc(s.projectPrefix)} &middot; ${done}/${total} done (${pct}%)</span>
    </div>
    <div class="sb-track">
      <div class="sb-fill" style="width:${pct}%"></div>
    </div>
  </div>`;
}

function activityItemHtml(ev) {
  const who = ev.actorName || "Someone";
  const arrow = `<span class="act-arrow">&rarr;</span>`;
  return `
  <div class="act-row">
    ${avatarHtml(who, ev.actorId)}
    <div class="act-body">
      <div class="act-text">
        <b>${esc(who)}</b> moved
        <span class="ticket-id">${esc(ev.ticketId)}</span>
        ${statusPill(ev.oldStatus, undefined, true)} ${arrow} ${statusPill(ev.newStatus, undefined, true)}
      </div>
      <div class="act-when">${esc(ev.projectPrefix)} &middot; ${fmtDate(ev.createdAt)}</div>
    </div>
  </div>`;
}

/* ---------- Charts ---------- */

function destroyCharts() {
  for (const key of Object.keys(charts)) {
    if (charts[key]) {
      charts[key].destroy();
      charts[key] = null;
    }
  }
}

function renderCharts(stats, isSuper, isAdmin) {
  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { font: { size: 12 } } } },
  };

  // Status doughnut
  const statusLabels = [];
  const statusData = [];
  const statusColors = [];
  for (const s of STATUSES) {
    if (stats.statusCounts[s]) {
      statusLabels.push(STATUS_LABELS[s]);
      statusData.push(stats.statusCounts[s]);
      statusColors.push(getStatusColor(s));
    }
  }
  if (statusData.length > 0) {
    charts.status = new Chart(document.getElementById("chart-status"), {
      type: "doughnut",
      data: {
        labels: statusLabels,
        datasets: [{ data: statusData, backgroundColor: statusColors, borderWidth: 2, borderColor: "#fff" }],
      },
      options: {
        ...chartDefaults,
        cutout: "55%",
        plugins: {
          ...chartDefaults.plugins,
          legend: { position: "right", labels: { font: { size: 12 }, padding: 12 } },
        },
      },
    });
  }

  // Priority donut
  const prioLabels = [];
  const prioData = [];
  const prioColors = [];
  for (const p of PRIORITIES) {
    if (stats.priorityCounts[p]) {
      prioLabels.push(PRIORITY_LABELS[p]);
      prioData.push(stats.priorityCounts[p]);
      prioColors.push(getPriorityColor(p));
    }
  }
  if (prioData.length > 0) {
    charts.priority = new Chart(document.getElementById("chart-priority"), {
      type: "doughnut",
      data: {
        labels: prioLabels,
        datasets: [{ data: prioData, backgroundColor: prioColors, borderWidth: 2, borderColor: "#fff" }],
      },
      options: {
        ...chartDefaults,
        cutout: "55%",
        plugins: {
          ...chartDefaults.plugins,
          legend: { position: "right", labels: { font: { size: 12 }, padding: 12 } },
        },
      },
    });
  }

  // Type pie
  const typeLabels = [];
  const typeData = [];
  const typeColors = ["#286EB4", "#C88214"];
  for (const t of TASK_TYPES) {
    if (stats.typeCounts[t]) {
      typeLabels.push(TYPE_LABELS[t]);
      typeData.push(stats.typeCounts[t]);
    }
  }
  if (typeData.length > 0) {
    charts.type = new Chart(document.getElementById("chart-type"), {
      type: "pie",
      data: {
        labels: typeLabels,
        datasets: [{ data: typeData, backgroundColor: typeColors, borderWidth: 2, borderColor: "#fff" }],
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { position: "bottom" } } },
    });
  }

  // Timeline (admin+)
  if (isAdmin) renderTimelineChart(stats, "daily");

  // Team workload (admin+)
  if (isAdmin && stats.teamWorkload.length > 0) {
    const wl = stats.teamWorkload.slice(0, 10);
    charts.workload = new Chart(document.getElementById("chart-workload"), {
      type: "bar",
      data: {
        labels: wl.map((w) => w.name.split(" ")[0]),
        datasets: [
          { label: "Open", data: wl.map((w) => w.openCount), backgroundColor: "#286EB4", borderRadius: 4 },
          { label: "Done", data: wl.map((w) => w.doneCount), backgroundColor: "#236E37", borderRadius: 4 },
        ],
      },
      options: {
        ...chartDefaults,
        indexAxis: "y",
        scales: { x: { beginAtZero: true, stacked: true, ticks: { stepSize: 1 } }, y: { stacked: true, grid: { display: false } } },
      },
    });
  }

  // Top assignees (super admin)
  if (isSuper && stats.topAssignees.length > 0) {
    charts.topAssignees = new Chart(document.getElementById("chart-top-assignees"), {
      type: "bar",
      data: {
        labels: stats.topAssignees.map((a) => a.name.split(" ")[0]),
        datasets: [{ data: stats.topAssignees.map((a) => a.total), backgroundColor: "#964826", borderRadius: 4 }],
      },
      options: {
        ...chartDefaults,
        indexAxis: "y",
        plugins: { ...chartDefaults.plugins, legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } }, y: { grid: { display: false } } },
      },
    });
  }

  // Projects overview (super admin)
  if (isSuper && stats.projectStats.length > 0) {
    charts.projects = new Chart(document.getElementById("chart-projects"), {
      type: "bar",
      data: {
        labels: stats.projectStats.map((p) => `${p.prefix} - ${p.name}`),
        datasets: [
          { label: "Open", data: stats.projectStats.map((p) => p.total - p.done), backgroundColor: "#286EB4", borderRadius: 4 },
          { label: "Done", data: stats.projectStats.map((p) => p.done), backgroundColor: "#236E37", borderRadius: 4 },
        ],
      },
      options: {
        ...chartDefaults,
        scales: { x: { stacked: true, grid: { display: false } }, y: { beginAtZero: true, stacked: true, ticks: { stepSize: 1 } } },
      },
    });
  }
}

function renderTimelineChart(stats, timeframe) {
  if (charts.timeline) {
    charts.timeline.destroy();
    charts.timeline = null;
  }

  const data = timeframe === "daily" ? stats.dailyStats : stats.weeklyStats;
  const labels = data.map((d) => timeframe === "daily" ? d.day.slice(5) : d.week);
  const created = data.map((d) => d.created);
  const completed = data.map((d) => d.completed);

  charts.timeline = new Chart(document.getElementById("chart-timeline"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Created", data: created, borderColor: "#286EB4", backgroundColor: "#286EB420", fill: true, tension: 0.3 },
        { label: "Completed", data: completed, borderColor: "#236E37", backgroundColor: "#236E3720", fill: true, tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { size: 12 } } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { stepSize: 1 } } },
    },
  });
}

function bindTimeframeToggle(stats, isSuper, isAdmin) {
  const toggle = document.getElementById("timeframe-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderTimelineChart(stats, btn.dataset.tf);
  });
}
