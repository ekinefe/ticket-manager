import { api } from "../api.js";
import { state } from "../main.js";
import { esc, statusPill, priorityPill } from "../ui.js";
import { t, langSwitcherHtml, bindLangSwitcher } from "../i18n.js";

// Public landing page for visitors who are not signed in.
export function renderLanding(root) {
  root.innerHTML = `
    <div class="landing">
      <div class="landing-lang">${langSwitcherHtml()}</div>
      <div class="landing-hero">
        <div class="brand-big">TM</div>
        <h1>Ticket Manager</h1>
        <p class="sub">${t("landing.tagline")}</p>
        <a class="btn" href="/login" data-nav>${t("common.signIn")}</a>
      </div>
      <div class="landing-features">
        <div class="landing-card"><h3>${t("landing.boards.title")}</h3><p>${t("landing.boards.body")}</p></div>
        <div class="landing-card"><h3>${t("landing.ids.title")}</h3><p>${t("landing.ids.body", { id: '<span class="ticket-id">TM-12</span>' })}</p></div>
        <div class="landing-card"><h3>${t("landing.github.title")}</h3><p>${t("landing.github.body")}</p></div>
        <div class="landing-card"><h3>${t("landing.invite.title")}</h3><p>${t("landing.invite.body")}</p></div>
      </div>
    </div>`;
  bindLangSwitcher(root);
}

// Home page shown after sign-in: greeting, the user's open tickets and projects.
export async function renderHome(root) {
  const first = String(state.user?.name || "").split(" ")[0] || t("home.there");
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
      <div class="page-head"><h1>${t("home.welcome", { name: esc(first) })}</h1></div>
      <p class="sub">${open.length
        ? (open.length === 1 ? t("home.openCount.one") : t("home.openCount.many", { count: open.length }))
        : t("home.noOpen")}</p>
      <div class="dash-grid">
        <div class="dash-panel">
          <div class="panel-head"><h3>${t("home.yourTickets")}</h3><a class="btn sm ghost" href="/my-tickets" data-nav>${t("home.allMyTickets")}</a></div>
          <div class="panel-body">
            ${open.slice(0, 8).map((t) => `
              <a class="dash-ticket" href="/projects/${encodeURIComponent(t.projectId)}?task=${encodeURIComponent(t.ticketId)}" data-nav>
                <span class="ticket-id">${esc(t.ticketId)}</span>
                <span class="dt-title">${esc(t.title)}</span>
                <span class="dt-meta">${statusPill(t.status, undefined, true)} ${priorityPill(t.priority)}</span>
              </a>`).join("") || `<div class="act-empty">${t("home.nothingToDo")}</div>`}
          </div>
        </div>
        <div class="dash-panel">
          <div class="panel-head"><h3>${t("home.yourProjects")}</h3><a class="btn sm ghost" href="/projects" data-nav>${t("home.allProjects")}</a></div>
          <div class="panel-body">
            ${projects.slice(0, 8).map((p) => `
              <a class="dash-ticket" href="/projects/${encodeURIComponent(p.id)}" data-nav>
                <span class="prefix-chip">${esc(p.prefix)}</span>
                <span class="dt-title">${esc(p.name)}</span>
              </a>`).join("") || `<div class="act-empty">${t("home.noProjects")}</div>`}
          </div>
        </div>
      </div>
    </div>`;
}
