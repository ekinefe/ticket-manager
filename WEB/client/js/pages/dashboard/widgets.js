import { esc, avatarHtml, statusPill, priorityPill, fmtDate } from "../../ui.js";
import { t as tl } from "../../i18n.js";

// Pure HTML builders for the dashboard cards, tables and activity feed.
export function statCardsHtml(stats, isSuper) {
  if (isSuper) {
    return `
    <div class="stat-cards">
      <div class="stat-card">
        <div class="stat-value">${stats.totalTickets}</div>
        <div class="stat-label">${tl("dash.totalTickets")}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.totalProjects}</div>
        <div class="stat-label">${tl("dash.projects")}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.totalUsers}</div>
        <div class="stat-label">${tl("dash.users")}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.myTickets.length}</div>
        <div class="stat-label">${tl("dash.myTickets")}</div>
      </div>
    </div>`;
  }

  return `
  <div class="stat-cards">
    <div class="stat-card">
      <div class="stat-value">${stats.totalTickets}</div>
      <div class="stat-label">${tl("dash.totalTickets")}</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.myProjects.length}</div>
      <div class="stat-label">${tl("dash.myProjects")}</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.myTickets.length}</div>
      <div class="stat-label">${tl("dash.myTickets")}</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.statusCounts["DONE"] || 0}</div>
      <div class="stat-label">${tl("dash.completed")}</div>
    </div>
  </div>`;
}

/* ---------- Ticket / sprint / activity rows ---------- */

export function ticketRowHtml(t) {
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

export function projectOverviewTableHtml(rows) {
  return `
  <table class="data po-table">
    <thead><tr>
      <th>${tl("dash.po.project")}</th><th class="po-progress-col">${tl("dash.po.progress")}</th>
      <th>${tl("dash.po.open")}</th><th>${tl("dash.po.done")}</th><th>${tl("dash.po.overdue")}</th>
      <th>${tl("dash.po.members")}</th><th>${tl("dash.po.last")}</th>
    </tr></thead>
    <tbody>${rows.map((p) => {
      const total = Number(p.total), done = Number(p.done), overdue = Number(p.overdue);
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      return `<tr>
        <td><a href="/projects/${encodeURIComponent(p.id)}" data-nav><span class="prefix-chip">${esc(p.prefix)}</span> ${esc(p.name)}</a></td>
        <td class="po-progress-col"><div class="sb-track"><div class="sb-fill" style="width:${pct}%"></div></div><span class="po-pct">${pct}%</span></td>
        <td>${total - done}</td><td>${done}</td>
        <td>${overdue > 0 ? `<span class="po-overdue">${overdue}</span>` : "0"}</td>
        <td>${Number(p.members)}</td>
        <td style="color:var(--text-dim)">${p.lastActivity ? fmtDate(p.lastActivity) : "-"}</td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;
}

export function sprintBarHtml(s) {
  const total = Number(s.total);
  const done = Number(s.done);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `
  <div class="sprint-bar">
    <div class="sb-head">
      <span class="ticket-id">${esc(s.sprintId)}</span>
      <span class="sb-name">${esc(s.name)}</span>
      <span class="sb-meta">${tl("dash.sprintMeta", { prefix: esc(s.projectPrefix), done, total, pct })}</span>
    </div>
    <div class="sb-track">
      <div class="sb-fill" style="width:${pct}%"></div>
    </div>
  </div>`;
}

export function activityItemHtml(ev) {
  const who = ev.actorName || tl("dash.someone");
  const arrow = `<span class="act-arrow">&rarr;</span>`;
  return `
  <div class="act-row">
    ${avatarHtml(who, ev.actorId)}
    <div class="act-body">
      <div class="act-text">
        <b>${esc(who)}</b> ${tl("dash.moved")}
        <a class="ticket-id" href="/projects/${encodeURIComponent(ev.projectId)}?task=${encodeURIComponent(ev.ticketId)}" data-nav>${esc(ev.ticketId)}</a>
        <span class="act-title">${esc(ev.taskTitle || "")}</span>
        ${statusPill(ev.oldStatus, undefined, true)} ${arrow} ${statusPill(ev.newStatus, undefined, true)}
      </div>
      <div class="act-when">${esc(ev.projectPrefix)} &middot; ${fmtDate(ev.createdAt)}</div>
    </div>
  </div>`;
}

/* ---------- Charts ---------- */
