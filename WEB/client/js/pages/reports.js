import { api } from "../api.js";
import { esc, fmtDate, STATUSES, STATUS_LABELS, getStatusColor } from "../ui.js";
import { t as tl, locale } from "../i18n.js";

// Reports: performance, tasks, completed work and a three-scenario forecast.
const COLORS = {
  scope: "#8b8b99", done: "#236E37", created: "#286EB4",
  optimistic: "#1e8c5a", realistic: "#286EB4", pessimistic: "#d6451f",
};
const charts = {};
const state = { granularity: "weekly", projectId: "" };

function destroyCharts() {
  for (const k of Object.keys(charts)) { charts[k]?.destroy(); delete charts[k]; }
}

const fmtShort = (iso, g) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return g === "monthly"
    ? d.toLocaleDateString(locale(), { month: "short", year: "2-digit", timeZone: "UTC" })
    : d.toLocaleDateString(locale(), { day: "2-digit", month: "short", timeZone: "UTC" });
};
const fmtLong = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale(), { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export async function renderReports(root) {
  root.innerHTML = `<div class="page"><div class="spinner"></div></div>`;
  await load(root);
}

async function load(root) {
  destroyCharts();
  let data;
  try {
    const q = new URLSearchParams({ granularity: state.granularity });
    if (state.projectId) q.set("projectId", state.projectId);
    data = await api.get(`/reports?${q}`);
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }
  const g = data.granularity;
  const k = data.kpis;
  const f = data.forecast;

  root.innerHTML = `
    <div class="page rep-page">
      <div class="page-head">
        <h1>${tl("rep.title")}</h1>
        <span class="spacer" style="flex:1"></span>
        <select id="rep-project" class="filter-select" aria-label="${tl("rep.project")}">
          <option value="">${tl("rep.allProjects")}</option>
          ${data.projects.map((p) => `<option value="${esc(p.id)}" ${state.projectId === p.id ? "selected" : ""}>${esc(p.prefix)} - ${esc(p.name)}</option>`).join("")}
        </select>
        <div class="chart-toggle" id="rep-gran">
          ${["daily", "weekly", "monthly"].map((x) => `<button class="btn sm ghost ${g === x ? "active" : ""}" data-g="${x}">${tl(`rep.${x}`)}</button>`).join("")}
        </div>
      </div>

      ${k.total === 0 ? `<div class="empty-note">${tl("rep.empty")}</div>` : `
      <div class="stat-cards">
        ${kpi(k.total, tl("rep.kpi.total"))}
        ${kpi(k.done, tl("rep.kpi.done"))}
        ${kpi(k.inProgress, tl("rep.kpi.inProgress"))}
        ${kpi(k.open - k.inProgress, tl("rep.kpi.notStarted"))}
        ${kpi(k.overdue, tl("rep.kpi.overdue"), k.overdue > 0 ? "rep-bad" : "")}
        ${kpi(`${k.completionRate}%`, tl("rep.kpi.rate"))}
        ${kpi(k.avgCycleDays === null ? "-" : tl("rep.days", { n: k.avgCycleDays }), tl("rep.kpi.cycle"))}
        ${kpi(k.throughput, tl("rep.kpi.throughput", { unit: tl(`rep.unit.${g}`) }))}
      </div>

      <div class="dash-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head"><h3>${tl("rep.forecast")}</h3></div>
          <div class="rep-scenarios">
            ${scenario("optimistic", f.optimistic, f.remaining, g)}
            ${scenario("realistic", f.realistic, f.remaining, g)}
            ${scenario("pessimistic", f.pessimistic, f.remaining, g)}
          </div>
          <div class="panel-body chart-wrap chart-wide"><canvas id="rep-burnup"></canvas></div>
          <p class="rep-note">${tl("rep.forecastNote")}</p>
        </div>
      </div>

      <div class="dash-grid">
        <div class="dash-panel">
          <div class="panel-head"><h3>${tl("rep.throughput")}</h3></div>
          <div class="panel-body chart-wrap chart-short"><canvas id="rep-throughput"></canvas></div>
        </div>
        <div class="dash-panel">
          <div class="panel-head"><h3>${tl("rep.byStatus")}</h3></div>
          <div class="panel-body chart-wrap chart-short"><canvas id="rep-status"></canvas></div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="dash-panel">
          <div class="panel-head"><h3>${tl("rep.performance")}</h3></div>
          <div class="panel-body chart-wrap chart-tall"><canvas id="rep-people"></canvas></div>
        </div>
        <div class="dash-panel">
          <div class="panel-head"><h3>${tl("rep.people")}</h3></div>
          <div class="panel-body">${peopleTable(data.assignees)}</div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="dash-panel dash-full">
          <div class="panel-head"><h3>${tl("rep.completed")}</h3></div>
          <div class="panel-body">${completedTable(data.completedList)}</div>
        </div>
      </div>`}
    </div>`;

  root.querySelector("#rep-project").addEventListener("change", (e) => { state.projectId = e.target.value; load(root); });
  root.querySelector("#rep-gran").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-g]");
    if (b) { state.granularity = b.dataset.g; load(root); }
  });
  if (k.total > 0) drawCharts(data);
}

const kpi = (value, label, cls = "") => `<div class="stat-card ${cls}"><div class="stat-value">${esc(value)}</div><div class="stat-label">${esc(label)}</div></div>`;

function scenario(kind, s, remaining, g) {
  const finish = remaining === 0 ? tl("rep.allDone")
    : s.finishDate ? tl("rep.finishBy", { date: fmtLong(s.finishDate) }) : tl("rep.never");
  const periods = s.periodsNeeded ? tl("rep.inPeriods", { n: s.periodsNeeded, unit: tl(`rep.unit.${g}`) }) : "";
  return `
    <div class="rep-scn rep-${kind}">
      <div class="rep-scn-name"><span class="rep-dot" style="background:${COLORS[kind]}"></span>${tl(`rep.${kind}`)}</div>
      <div class="rep-scn-date">${finish}</div>
      <div class="rep-scn-meta">${tl("rep.pace", { v: s.velocity, unit: tl(`rep.unit.${g}`) })}${periods ? ` · ${periods}` : ""}</div>
    </div>`;
}

function peopleTable(rows) {
  return `<table class="data"><thead><tr>
    <th>${tl("rep.col.person")}</th><th>${tl("rep.col.assigned")}</th><th>${tl("rep.col.done")}</th>
    <th>${tl("rep.col.open")}</th><th>${tl("rep.col.overdue")}</th><th>${tl("rep.col.cycle")}</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.name || tl("rep.unassigned"))}</td><td>${r.assigned}</td><td>${r.completed}</td><td>${r.open}</td>
      <td>${r.overdue ? `<span class="po-overdue">${r.overdue}</span>` : 0}</td>
      <td>${r.avgCycleDays === null ? "-" : tl("rep.days", { n: r.avgCycleDays })}</td></tr>`).join("")}</tbody></table>`;
}

function completedTable(rows) {
  if (rows.length === 0) return `<div class="empty-note">${tl("rep.noCompleted")}</div>`;
  return `<table class="data"><thead><tr>
    <th>${tl("rep.col.ticket")}</th><th>${tl("rep.col.title")}</th><th>${tl("rep.col.person")}</th>
    <th>${tl("rep.col.completedAt")}</th><th>${tl("rep.col.took")}</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><span class="prefix-chip">${esc(r.project)}</span> <span class="ticket-id">${esc(r.ticketId)}</span></td>
      <td>${esc(r.title)}</td><td>${esc(r.assignee || tl("rep.unassigned"))}</td>
      <td style="color:var(--text-dim)">${fmtDate(r.completedAt)}</td><td>${tl("rep.days", { n: r.cycleDays })}</td></tr>`).join("")}</tbody></table>`;
}

function drawCharts(data) {
  const g = data.granularity;
  const f = data.forecast;
  const hist = data.series;
  const histLabels = hist.map((s) => fmtShort(s.start, g));
  const futLabels = f.futureLabels.map((d) => fmtShort(d, g));
  const labels = [...histLabels, ...futLabels];
  const nHist = hist.length;
  const lastDone = hist[nHist - 1].cumCompleted;
  const scope = hist[nHist - 1].cumCreated;
  const pad = (arr) => [...new Array(nHist - 1).fill(null), lastDone, ...arr];
  const line = (label, color, data, dashed) => ({
    label, data, borderColor: color, backgroundColor: color, borderWidth: dashed ? 2 : 3,
    borderDash: dashed ? [7, 5] : [], pointRadius: 0, tension: 0.2, spanGaps: false,
  });

  charts.burnup = new Chart(document.getElementById("rep-burnup"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { ...line(tl("rep.scope"), COLORS.scope, [...hist.map((s) => s.cumCreated), ...new Array(f.horizon).fill(scope)], false), stepped: true, borderWidth: 2 },
        line(tl("rep.actual"), COLORS.done, hist.map((s) => s.cumCompleted), false),
        line(tl("rep.optimistic"), COLORS.optimistic, pad(f.optimistic.points), true),
        line(tl("rep.realistic"), COLORS.realistic, pad(f.realistic.points), true),
        line(tl("rep.pessimistic"), COLORS.pessimistic, pad(f.pessimistic.points), true),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { font: { size: 12 } } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: tl("rep.tickets") } } },
    },
  });

  charts.throughput = new Chart(document.getElementById("rep-throughput"), {
    type: "bar",
    data: {
      labels: histLabels,
      datasets: [
        { label: tl("rep.created"), data: hist.map((s) => s.created), backgroundColor: COLORS.created, borderRadius: 3 },
        { label: tl("rep.completedSeries"), data: hist.map((s) => s.completed), backgroundColor: COLORS.done, borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { size: 12 } } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });

  const present = STATUSES.filter((s) => data.byStatus[s]);
  charts.status = new Chart(document.getElementById("rep-status"), {
    type: "doughnut",
    data: { labels: present.map((s) => STATUS_LABELS[s]), datasets: [{ data: present.map((s) => data.byStatus[s]), backgroundColor: present.map(getStatusColor), borderWidth: 2, borderColor: "#fff" }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { font: { size: 12 }, padding: 12 } } } },
  });

  const people = data.assignees.slice(0, 10);
  charts.people = new Chart(document.getElementById("rep-people"), {
    type: "bar",
    data: {
      labels: people.map((p) => p.name || tl("rep.unassigned")),
      datasets: [
        { label: tl("rep.col.done"), data: people.map((p) => p.completed), backgroundColor: COLORS.done, borderRadius: 3 },
        { label: tl("rep.col.open"), data: people.map((p) => p.open), backgroundColor: COLORS.created, borderRadius: 3 },
      ],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { size: 12 } } } },
      scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false } } },
    },
  });
}

export { destroyCharts as destroyReportCharts };
