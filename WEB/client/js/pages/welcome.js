import { api } from "../api.js";
import { state } from "../main.js";
import { esc, statusPill, priorityPill } from "../ui.js";

// Public landing page for visitors who are not signed in.
export function renderLanding(root) {
  root.innerHTML = `
    <div class="landing">
      <div class="landing-hero">
        <div class="brand-big">TM</div>
        <h1>Ticket Manager</h1>
        <p class="sub">Plan work, track tickets and ship together &mdash; one board for your whole team.</p>
        <a class="btn" href="/login" data-nav>Sign in</a>
      </div>
      <div class="landing-features">
        <div class="landing-card"><h3>Boards &amp; sprints</h3><p>Drag tickets across statuses and sprint lanes, with live updates for everyone.</p></div>
        <div class="landing-card"><h3>Unique ticket IDs</h3><p>Every ticket gets an ID like <span class="ticket-id">TM-12</span> you can use in branches, commits and pull requests.</p></div>
        <div class="landing-card"><h3>GitHub linked</h3><p>See commits and PRs on each ticket and move tickets automatically when a PR opens or merges.</p></div>
        <div class="landing-card"><h3>Invitation only</h3><p>Accounts are created by an administrator. Ask yours for an invite to get started.</p></div>
      </div>
    </div>`;
}

// Home page shown after sign-in: greeting, the user's open tickets and projects.
export async function renderHome(root) {
  const first = String(state.user?.name || "").split(" ")[0] || "there";
  root.innerHTML = `<div class="spinner"></div>`;
  let tickets = [];
  let projects = [];
  try {
    [tickets, projects] = await Promise.all([api.get("/my-tickets"), api.get("/projects")]);
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }
  const open = tickets.filter((t) => t.status !== "DONE");
  root.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Welcome back, ${esc(first)}</h1></div>
      <p class="sub">${open.length
        ? `You have ${open.length} open ticket${open.length === 1 ? "" : "s"} assigned to you.`
        : "You have no open tickets assigned to you. Nice."}</p>
      <div class="dash-grid">
        <div class="dash-panel">
          <div class="panel-head"><h3>Your open tickets</h3><a class="btn sm ghost" href="/my-tickets" data-nav>All my tickets</a></div>
          <div class="panel-body">
            ${open.slice(0, 8).map((t) => `
              <a class="dash-ticket" href="/projects/${encodeURIComponent(t.projectId)}?task=${encodeURIComponent(t.ticketId)}" data-nav>
                <span class="ticket-id">${esc(t.ticketId)}</span>
                <span class="dt-title">${esc(t.title)}</span>
                <span class="dt-meta">${statusPill(t.status, undefined, true)} ${priorityPill(t.priority)}</span>
              </a>`).join("") || `<div class="act-empty">Nothing to do right now.</div>`}
          </div>
        </div>
        <div class="dash-panel">
          <div class="panel-head"><h3>Your projects</h3><a class="btn sm ghost" href="/projects" data-nav>All projects</a></div>
          <div class="panel-body">
            ${projects.slice(0, 8).map((p) => `
              <a class="dash-ticket" href="/projects/${encodeURIComponent(p.id)}" data-nav>
                <span class="prefix-chip">${esc(p.prefix)}</span>
                <span class="dt-title">${esc(p.name)}</span>
              </a>`).join("") || `<div class="act-empty">You are not a member of any project yet.</div>`}
          </div>
        </div>
      </div>
    </div>`;
}
