import { STATUSES, STATUS_LABELS, getStatusColor, PRIORITIES, PRIORITY_LABELS, getPriorityColor, TASK_TYPES, TYPE_LABELS } from "../../ui.js";
import { t as tl } from "../../i18n.js";

// Chart.js rendering (global `Chart` from the CDN script). Owns the live chart instances.
let charts = {};

export function destroyCharts() {
  for (const key of Object.keys(charts)) {
    if (charts[key]) {
      charts[key].destroy();
      charts[key] = null;
    }
  }
}

export function renderCharts(stats, isSuper, isAdmin) {
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
          { label: tl("dash.open"), data: wl.map((w) => w.openCount), backgroundColor: "#286EB4", borderRadius: 4 },
          { label: tl("dash.done"), data: wl.map((w) => w.doneCount), backgroundColor: "#236E37", borderRadius: 4 },
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
        datasets: [{ data: stats.topAssignees.map((a) => a.total), backgroundColor: "#286EB4", borderRadius: 4 }],
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
          { label: tl("dash.open"), data: stats.projectStats.map((p) => p.total - p.done), backgroundColor: "#286EB4", borderRadius: 4 },
          { label: tl("dash.done"), data: stats.projectStats.map((p) => p.done), backgroundColor: "#236E37", borderRadius: 4 },
        ],
      },
      options: {
        ...chartDefaults,
        scales: { x: { stacked: true, grid: { display: false } }, y: { beginAtZero: true, stacked: true, ticks: { stepSize: 1 } } },
      },
    });
  }
}

// Days without activity are absent from the API; add them as zeros so the line
// doesn't skip over quiet days.
function fillMissingDays(rows) {
  if (!rows.length) return rows;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const end = new Date();
  for (let d = new Date(`${rows[0].day}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) {
    const day = fmt(d);
    out.push(byDay.get(day) || { day, created: 0, completed: 0 });
  }
  return out;
}

function renderTimelineChart(stats, timeframe) {
  if (charts.timeline) {
    charts.timeline.destroy();
    charts.timeline = null;
  }

  const data = timeframe === "daily" ? fillMissingDays(stats.dailyStats) : stats.weeklyStats;
  const labels = data.map((d) => timeframe === "daily" ? d.day.slice(5) : d.week);
  const created = data.map((d) => d.created);
  const completed = data.map((d) => d.completed);

  charts.timeline = new Chart(document.getElementById("chart-timeline"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: tl("dash.created"), data: created, borderColor: "#286EB4", backgroundColor: "#286EB420", fill: true, tension: 0.3 },
        { label: tl("dash.completed"), data: completed, borderColor: "#236E37", backgroundColor: "#236E3720", fill: true, tension: 0.3 },
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

export function bindTimeframeToggle(stats, isSuper, isAdmin) {
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
