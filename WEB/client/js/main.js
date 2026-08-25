import { api } from "./api.js";
import { esc, roleChip, avatarHtml } from "./ui.js";
import { renderLogin } from "./pages/login.js";
import { renderProjects } from "./pages/projects.js";
import { renderBoard, renderMembersTab } from "./pages/board.js";
import { renderAcceptInvite } from "./pages/accept-invite.js";
import { renderAdmin } from "./pages/admin.js";
import { renderMyTickets } from "./pages/my-tickets.js";
import { renderResetPassword } from "./pages/reset-password.js";

export const state = {
  user: null, // { id, name, email, role }
  projectsCache: null,
};

export function navigate(path) {
  history.pushState(null, "", path);
  route();
}

export async function loadProjects(force = false) {
  if (!state.projectsCache || force) {
    state.projectsCache = await api.get("/projects");
  }
  return state.projectsCache;
}

function topbarHtml() {
  const u = state.user;
  return `
    <a class="brand" href="/projects" data-nav>
      <span class="logo">TM</span> Ticket Manager
    </a>
    <div class="topsearch">
      <svg class="search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line>
      </svg>
      <input type="text" id="global-search" placeholder="Search tickets, projects${u.role !== "USER" ? ", users" : ""}…" autocomplete="off" spellcheck="false" />
      <span class="search-kbd" id="search-kbd">Ctrl K</span>
      <div class="search-drop hidden" id="search-drop"></div>
    </div>
    <span class="spacer"></span>
    <div class="userbox">
      <div class="meta">
        <div class="name">${esc(u.name)}</div>
        ${roleChip(u.role)}
      </div>
      ${avatarHtml(u.name, u.id)}
      <button class="btn subtle sm" id="signout-btn" title="Sign out">Sign out</button>
    </div>`;
}

function bindGlobalSearch(topbar) {
  const input = topbar.querySelector("#global-search");
  const drop = topbar.querySelector("#search-drop");
  if (!input || !drop) return;
  let timer = null;
  let lastQuery = "";

  const kbd = topbar.querySelector("#search-kbd");
  if (kbd) kbd.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  const close = () => drop.classList.add("hidden");

  const render = (data, q) => {
    const t = data.tickets || [], p = data.projects || [], u = data.users || [];
    if (!t.length && !p.length && !u.length) {
      drop.innerHTML = `
        <div class="sr-empty">
          No matches for &ldquo;${esc(q)}&rdquo;
          <div style="margin-top:4px;font-size:12px">Check the spelling, or try a ticket ID like <span class="ticket-id">PLN-3</span></div>
        </div>`;
    } else {
      drop.innerHTML = `
        ${data.suggested ? `<div class="sr-group sr-suggested">Did you mean</div>` : ""}
        ${t.length ? `<div class="sr-group">Tickets</div>${t.map((x) => `
          <a class="sr-item" href="/projects/${encodeURIComponent(x.projectId)}" data-nav>
            <span class="ticket-id">${esc(x.ticketId)}</span>
            <span class="sr-title">${esc(x.title)}</span>
            <span class="sr-meta">${esc(x.projectPrefix)}</span>
          </a>`).join("")}` : ""}
        ${p.length ? `<div class="sr-group">Projects</div>${p.map((x) => `
          <a class="sr-item" href="/projects/${encodeURIComponent(x.id)}" data-nav>
            <span class="prefix-chip">${esc(x.prefix)}</span>
            <span class="sr-title">${esc(x.name)}</span>
          </a>`).join("")}` : ""}
        ${u.length ? `<div class="sr-group">Users</div>${u.map((x) => `
          <a class="sr-item" href="/admin/users" data-nav>
            ${avatarHtml(x.name, x.id)}
            <span class="sr-title">${esc(x.name)} <span style="color:var(--text-dim)">&middot; ${esc(x.email)}</span></span>
            ${roleChip(x.role)}
          </a>`).join("")}` : ""}`;
    }
    drop.classList.remove("hidden");
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    lastQuery = q;
    if (q.length < 1) { close(); return; }
    timer = setTimeout(async () => {
      try {
        const data = await api.get(`/search?q=${encodeURIComponent(q)}`);
        if (input.value.trim() === q && q === lastQuery) render(data, q);
      } catch { close(); }
    }, 220);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; close(); input.blur(); }
  });

  // mousedown fires before the document click handler / blur
  drop.addEventListener("mousedown", (e) => e.preventDefault());
  document.addEventListener("click", (e) => {
    if (!drop.contains(e.target) && e.target !== input) close();
  });
}

export function requireAuth(next) {
  if (!state.user) {
    navigate(`/login?next=${encodeURIComponent(next || location.pathname)}`);
    return false;
  }
  return true;
}

function sidebarHtml(activeId, activePath) {
  const projects = Array.isArray(state.projectsCache) ? state.projectsCache : [];
  const isSuper = state.user.role === "SUPER_ADMIN";
  return `
    <aside class="proj-sidebar">
      <a class="side-head" href="/projects" data-nav>Projects</a>
      <nav class="side-list">
        <a class="side-item${activePath === "/my-tickets" ? " active" : ""}" href="/my-tickets" data-nav>My Tickets</a>
        <div class="side-sep"></div>
        ${projects.map((p) => `
          <a class="side-item${p.id === activeId ? " active" : ""}" href="/projects/${encodeURIComponent(p.id)}" data-nav title="${esc(p.name)}">
            <span class="prefix-chip">${esc(p.prefix)}</span>
            <span class="side-name">${esc(p.name)}</span>
          </a>`).join("")}
        ${projects.length === 0 ? `<span class="side-empty">No projects yet</span>` : ""}
      </nav>
      ${isSuper ? `
      <div class="side-footer">
        <div class="side-sep"></div>
        <a class="side-item${activePath.startsWith("/admin") ? " active" : ""}" href="/admin/users" data-nav>
          <span class="side-ico">&#9881;</span> Admin Panel
        </a>
      </div>` : ""}
    </aside>`;
}

async function route() {
  const path = location.pathname;
  const appEl = document.getElementById("app");
  const topbar = document.getElementById("topbar");

  // Public routes
  if (path === "/accept-invite") {
    topbar.classList.add("hidden");
    await renderAcceptInvite(appEl);
    return;
  }

  if (path === "/login") {
    if (state.user) { navigate("/projects"); return; }
    topbar.classList.add("hidden");
    await renderLogin(appEl);
    return;
  }

  if (path === "/reset-password") {
    topbar.classList.add("hidden");
    await renderResetPassword(appEl);
    return;
  }

  // Everything else requires a session
  if (!state.user) {
    const params = new URLSearchParams(location.search);
    navigate(`/login?next=${encodeURIComponent(params.get("next") || path)}`);
    return;
  }

  topbar.classList.remove("hidden");
  topbar.innerHTML = topbarHtml();
  bindGlobalSearch(topbar);
  topbar.querySelector("#signout-btn").addEventListener("click", async () => {
    await api.signOut().catch(() => {});
    state.user = null;
    state.projectsCache = null;
    navigate("/login");
  });

  // Persistent app shell: sidebar + page area (admin included)
  let pm;
  const activeId = (pm = path.match(/^\/projects\/([^/]+)/)) ? decodeURIComponent(pm[1]) : null;
  await loadProjects().catch(() => {});
  appEl.innerHTML = `
    <div class="shell">
      ${sidebarHtml(activeId, path)}
      <main class="shell-main" id="page"></main>
    </div>`;
  const page = document.getElementById("page");

  let m;
  if (path === "/" || path === "" ) { navigate("/projects"); return; }
  if (path === "/projects") {
    await renderProjects(page);
  } else if (path === "/my-tickets") {
    await renderMyTickets(page);
  } else if ((m = path.match(/^\/projects\/([^/]+)$/))) {
    await renderBoard(page, decodeURIComponent(m[1]));
  } else if ((m = path.match(/^\/projects\/([^/]+)\/members$/))) {
    await renderMembersTab(page, decodeURIComponent(m[1]));
  } else if (path === "/admin" || path === "/admin/users") {
    await renderAdmin(page, "users");
  } else if (path === "/admin/projects") {
    await renderAdmin(page, "projects");
  } else {
    page.innerHTML = `<div class="page"><h1>Page not found</h1><p><a href="/projects" data-nav>Back to projects</a></p></div>`;
  }
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-nav]");
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

window.addEventListener("popstate", route);

(async function boot() {
  const session = await api.session().catch(() => null);
  state.user = session?.user ?? null;
  await route();
})();
