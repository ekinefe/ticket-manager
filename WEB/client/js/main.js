import { api } from "./api.js";
import { esc, roleChip, avatarHtml } from "./ui.js";
import { renderLogin } from "./pages/login.js";
import { renderProjects } from "./pages/projects.js";
import { renderBoard, renderMembersTab, renderSprintsTab } from "./pages/board.js";
import { renderAcceptInvite } from "./pages/accept-invite.js";
import { renderAdmin } from "./pages/admin.js";
import { renderMyTickets } from "./pages/my-tickets.js";
import { renderResetPassword } from "./pages/reset-password.js";
import { renderDashboard } from "./pages/dashboard.js";
import { closeBoardStream } from "./pages/board.js";

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
    <button class="nav-toggle" id="nav-toggle" type="button" aria-label="Open navigation" title="Menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18" aria-hidden="true">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <a class="brand" href="/projects" data-nav>
      <span class="logo">TM</span> <span class="brand-text">Ticket Manager</span>
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
    <div class="notif-wrap" id="notif-wrap">
      <button class="notif-bell" id="notif-bell" title="Notifications">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        <span class="notif-badge hidden" id="notif-badge">0</span>
      </button>
      <div class="notif-dropdown hidden" id="notif-dropdown">
        <div class="notif-head">
          <span class="notif-title">Notifications</span>
          <button class="btn sm ghost" id="notif-mark-all">Mark all read</button>
        </div>
        <div class="notif-list" id="notif-list">
          <div class="notif-empty">No notifications yet</div>
        </div>
      </div>
    </div>
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
    const t = data.tickets || [], p = data.projects || [], u = data.users || [], s = data.sprints || [];
    if (!t.length && !p.length && !u.length && !s.length) {
      drop.innerHTML = `
        <div class="sr-empty">
          No matches for &ldquo;${esc(q)}&rdquo;
          <div style="margin-top:4px;font-size:12px">Check the spelling, or try a ticket ID like <span class="ticket-id">PLN-3</span> or a sprint like <span class="ticket-id">PLN-S1</span></div>
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
        ${s.length ? `<div class="sr-group">Sprints</div>${s.map((x) => `
          <a class="sr-item" href="/projects/${encodeURIComponent(x.projectId)}/sprints" data-nav>
            <span class="ticket-id">${esc(x.sprintId)}</span>
            <span class="sr-title">${esc(x.name)}</span>
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

const sidebarState = {
  projectsCollapsed: false,
  collapsedProjects: new Set(), // project ids whose sub-list is collapsed
};

function sidebarHtml(activeId, activePath) {
  const u = state.user;
  const projects = Array.isArray(state.projectsCache) ? state.projectsCache : [];
  const isSuper = state.user.role === "SUPER_ADMIN";
  const ICON_DASH =
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;flex-shrink:0"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
  const ICON_TICKET =
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;flex-shrink:0"><path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M13 6v12" stroke-dasharray="2 2"/></svg>`;
  const CARET = `<span class="side-caret">&#9656;</span>`;

  const projItems = projects.map((p) => {
    const projPath = `/projects/${encodeURIComponent(p.id)}`;
    const projActive = activePath === projPath ||
      activePath === `${projPath}/members` ||
      activePath === `${projPath}/sprints`;
    const subOpen = projActive || !sidebarState.collapsedProjects.has(p.id);
    const dashActive = activePath === projPath;
    const memActive = activePath === `${projPath}/members`;
    const sprActive = activePath === `${projPath}/sprints`;
    return `
      <div class="side-proj${projActive ? " active" : ""}">
        <div class="side-proj-row">
          <button class="side-proj-toggle${subOpen ? " open" : ""}" type="button"
                  data-proj="${esc(p.id)}" aria-label="Toggle project">${CARET}</button>
          <a class="side-item proj-link${dashActive ? " active" : ""}" href="${projPath}" data-nav title="${esc(p.name)}">
            <span class="prefix-chip">${esc(p.prefix)}</span>
            <span class="side-name">${esc(p.name)}</span>
          </a>
        </div>
        <div class="side-proj-sub${subOpen ? "" : " collapsed"}" data-proj-sub="${esc(p.id)}">
          <a class="side-sub${dashActive ? " active" : ""}" href="${projPath}" data-nav>Board</a>
          <a class="side-sub${memActive ? " active" : ""}" href="${projPath}/members" data-nav>Members</a>
          <a class="side-sub${sprActive ? " active" : ""}" href="${projPath}/sprints" data-nav>Sprints</a>
        </div>
      </div>`;
  }).join("");

  return `
    <aside class="proj-sidebar">
      <nav class="side-list">
        <a class="side-item${activePath === "/dashboard" ? " active" : ""}" href="/dashboard" data-nav>
          ${ICON_DASH} Dashboard
        </a>

        <div class="side-group-head${sidebarState.projectsCollapsed ? "" : " open"}" id="projects-toggle">
          <button class="side-caret-btn" type="button" data-projects-toggle aria-label="Toggle projects">${CARET}</button>
          <a class="side-group-label" href="/projects" data-nav>Projects</a>
          <span class="side-count">${projects.length}</span>
        </div>
        <div class="side-group${sidebarState.projectsCollapsed ? " collapsed" : ""}" id="projects-group">
          ${projItems}
          ${projects.length === 0 ? `<span class="side-empty">No projects yet</span>` : ""}
        </div>

        <div class="side-sep"></div>

        <a class="side-item${activePath === "/my-tickets" ? " active" : ""}" href="/my-tickets" data-nav>
          ${ICON_TICKET} My Tickets
        </a>
      </nav>

      <div class="side-tools">
        <div class="side-sep"></div>
        <button class="side-item side-tool" id="theme-toggle" type="button" title="Toggle dark / light theme">
          <span class="side-ico" id="theme-ico"></span><span>Dark / Light</span>
        </button>
        <button class="side-item side-tool" id="grid-toggle" type="button" title="Toggle grid background">
          <span class="side-ico" id="grid-ico"></span><span>Grid background</span>
        </button>
      </div>

      ${isSuper ? `
      <div class="side-footer">
        <div class="side-sep"></div>
        <a class="side-item${activePath.startsWith("/admin") ? " active" : ""}" href="/admin/users" data-nav>
          <span class="side-ico">&#9881;</span> Admin Panel
        </a>
      </div>` : ""}

      <div class="side-mobile-only">
        <div class="side-sep"></div>
        <div class="side-user">
          ${avatarHtml(u.name, u.id)}
          <div class="side-user-meta">
            <div class="name">${esc(u.name)}</div>
            ${roleChip(u.role)}
          </div>
        </div>
        <button class="btn subtle sm side-signout" id="side-signout" type="button">Sign out</button>
      </div>
    </aside>`;
}

function bindSidebar(shell) {
  const groupToggle = shell.querySelector("[data-projects-toggle]");
  const group = shell.querySelector("#projects-group");
  const groupHead = shell.querySelector("#projects-toggle");
  if (groupToggle && group) {
    groupToggle.addEventListener("click", () => {
      sidebarState.projectsCollapsed = !sidebarState.projectsCollapsed;
      groupHead.classList.toggle("open", !sidebarState.projectsCollapsed);
      group.classList.toggle("collapsed", sidebarState.projectsCollapsed);
    });
  }

  shell.querySelectorAll(".side-proj-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.proj;
      const sub = shell.querySelector(`[data-proj-sub="${cssEscape(id)}"]`);
      if (!sub) return;
      const willOpen = sub.classList.contains("collapsed");
      sub.classList.toggle("collapsed", !willOpen);
      btn.classList.toggle("open", willOpen);
      if (willOpen) sidebarState.collapsedProjects.delete(id);
      else sidebarState.collapsedProjects.add(id);
    });
  });
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, "\\$&");
}

async function signOut() {
  await api.signOut().catch(() => {});
  state.user = null;
  state.projectsCache = null;
  navigate("/login");
}

function bindNavToggle(topbar, appEl) {
  const btn = topbar.querySelector("#nav-toggle");
  const sb = appEl.querySelector(".proj-sidebar");
  const scrim = appEl.querySelector("#nav-scrim");
  if (!btn || !sb) return;
  const setOpen = (open) => {
    sb.classList.toggle("open", open);
    if (scrim) scrim.classList.toggle("open", open);
  };
  btn.addEventListener("click", () => setOpen(!sb.classList.contains("open")));
  if (scrim) scrim.addEventListener("click", () => setOpen(false));
  const sideSignout = appEl.querySelector("#side-signout");
  if (sideSignout) sideSignout.addEventListener("click", signOut);
}

async function route() {
  const path = location.pathname;
  const appEl = document.getElementById("app");
  const topbar = document.getElementById("topbar");
  closeBoardStream();

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
  topbar.querySelector("#signout-btn").addEventListener("click", signOut);

  bindNotifications(topbar);

  // Persistent app shell: sidebar + page area (admin included)
  let pm;
  const activeId = (pm = path.match(/^\/projects\/([^/]+)/)) ? decodeURIComponent(pm[1]) : null;
  await loadProjects().catch(() => {});
  appEl.innerHTML = `
    <div class="shell">
      ${sidebarHtml(activeId, path)}
      <div class="nav-scrim" id="nav-scrim"></div>
      <main class="shell-main" id="page"></main>
    </div>`;
  const page = document.getElementById("page");
  bindSidebar(appEl);
  bindNavToggle(topbar, appEl);
  bindThemeControls();

  let m;
  if (path === "/" || path === "" ) { navigate("/dashboard"); return; }
  if (path === "/dashboard") {
    await renderDashboard(page);
  } else if (path === "/projects") {
    await renderProjects(page);
  } else if (path === "/my-tickets") {
    await renderMyTickets(page);
  } else if ((m = path.match(/^\/projects\/([^/]+)$/))) {
    const sprintParam = new URLSearchParams(location.search).get("sprint") || "";
    const taskParam = new URLSearchParams(location.search).get("task") || "";
    await renderBoard(page, decodeURIComponent(m[1]), sprintParam, taskParam);
  } else if ((m = path.match(/^\/projects\/([^/]+)\/members$/))) {
    await renderMembersTab(page, decodeURIComponent(m[1]));
  } else if ((m = path.match(/^\/projects\/([^/]+)\/sprints$/))) {
    await renderSprintsTab(page, decodeURIComponent(m[1]));
  } else if (path === "/admin" || path === "/admin/users") {
    await renderAdmin(page, "users");
  } else if (path === "/admin/projects") {
    await renderAdmin(page, "projects");
  } else if (path === "/admin/settings") {
    await renderAdmin(page, "settings");
  } else {
    page.innerHTML = `<div class="page"><h1>Page not found</h1><p><a href="/projects" data-nav>Back to projects</a></p></div>`;
  }
}

let notifPollTimer = null;

function bindNotifications(topbar) {
  const bell = topbar.querySelector("#notif-bell");
  const dropdown = topbar.querySelector("#notif-dropdown");
  const list = topbar.querySelector("#notif-list");
  const badge = topbar.querySelector("#notif-badge");
  const markAllBtn = topbar.querySelector("#notif-mark-all");
  if (!bell || !dropdown || !list || !badge) return;

  let open = false;

  const toggle = () => {
    open = !open;
    dropdown.classList.toggle("hidden", !open);
    if (open) loadNotifList();
  };

  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target) && !bell.contains(e.target)) {
      open = false;
      dropdown.classList.add("hidden");
    }
  });

  if (markAllBtn) {
    markAllBtn.addEventListener("click", async () => {
      await api.patch("/notifications/read-all").catch(() => {});
      badge.classList.add("hidden");
      badge.textContent = "0";
      loadNotifList();
    });
  }

  async function loadBadge() {
    try {
      const { count } = await api.get("/notifications/unread-count");
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.classList.toggle("hidden", count === 0);
    } catch {}
  }

  async function loadNotifList() {
    try {
      const { notifications: items } = await api.get("/notifications?limit=20");
      if (!items || items.length === 0) {
        list.innerHTML = `<div class="notif-empty">No notifications yet</div>`;
        return;
      }
      list.innerHTML = items.map((n) => {
        const unread = !n.readAt;
        const time = fmtNotifTime(n.createdAt);
        const icon = notifIcon(n.type);
        return `<div class="notif-item${unread ? " unread" : ""}" data-id="${esc(n.id)}" data-project="${esc(n.projectId || "")}" data-task="${esc(n.taskId || "")}">
          <span class="notif-icon">${icon}</span>
          <div class="notif-body">
            <div class="notif-msg">${esc(n.message)}</div>
            <div class="notif-when">${time}</div>
            <div class="notif-actions">
              ${unread
                ? `<button class="btn sm ghost notif-btn-read" data-id="${esc(n.id)}">Mark read</button>`
                : `<button class="btn sm ghost notif-btn-unread" data-id="${esc(n.id)}">Mark unread</button>`}
              ${n.taskId ? `<button class="btn sm primary notif-btn-show" data-project="${esc(n.projectId || "")}" data-task="${esc(n.taskId)}">Show</button>` : ""}
            </div>
          </div>
        </div>`;
      }).join("");

      list.querySelectorAll(".notif-btn-read").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const nid = btn.dataset.id;
          await api.patch(`/notifications/${nid}/read`).catch(() => {});
          const item = btn.closest(".notif-item");
          if (item) item.classList.remove("unread");
          btn.outerHTML = `<button class="btn sm ghost notif-btn-unread" data-id="${esc(nid)}">Mark unread</button>`;
          bindNotifToggle(list);
          loadBadge();
        });
      });

      bindNotifToggle(list);

      list.querySelectorAll(".notif-btn-show").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const pid = btn.dataset.project;
          const tid = btn.dataset.task;
          open = false;
          dropdown.classList.add("hidden");
          navigate(`/projects/${encodeURIComponent(pid)}?task=${tid}`);
        });
      });
    } catch {}
  }

  loadBadge();
  clearInterval(notifPollTimer);
  notifPollTimer = setInterval(loadBadge, 30000);
}

function bindNotifToggle(list) {
  list.querySelectorAll(".notif-btn-unread").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const nid = btn.dataset.id;
      await api.patch(`/notifications/${nid}/unread`).catch(() => {});
      const item = btn.closest(".notif-item");
      if (item) item.classList.add("unread");
      btn.outerHTML = `<button class="btn sm ghost notif-btn-read" data-id="${esc(nid)}">Mark read</button>`;
      bindNotifToggle(list);
      loadBadge();
    };
  });
  list.querySelectorAll(".notif-btn-read").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const nid = btn.dataset.id;
      await api.patch(`/notifications/${nid}/read`).catch(() => {});
      const item = btn.closest(".notif-item");
      if (item) item.classList.remove("unread");
      btn.outerHTML = `<button class="btn sm ghost notif-btn-unread" data-id="${esc(nid)}">Mark unread</button>`;
      bindNotifToggle(list);
      loadBadge();
    };
  });
}

function bindThemeControls() {
  const themeBtn = document.getElementById("theme-toggle");
  const gridBtn = document.getElementById("grid-toggle");
  if (!themeBtn || !gridBtn) return;

  const savedTheme = localStorage.getItem("tm-theme") || "dark";
  const savedGrid = localStorage.getItem("tm-grid") || "off";
  applyTheme(savedTheme, savedGrid);

  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    const next = cur === "dark" ? "light" : "dark";
    applyTheme(next, document.documentElement.getAttribute("data-grid") || "off");
  });

  gridBtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-grid") || "off";
    const next = cur === "on" ? "off" : "on";
    applyTheme(document.documentElement.getAttribute("data-theme") || "dark", next);
  });
}

function applyTheme(theme, grid) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-grid", grid);
  localStorage.setItem("tm-theme", theme);
  localStorage.setItem("tm-grid", grid);

  const themeIco = document.getElementById("theme-ico");
  const gridIco = document.getElementById("grid-ico");
  const gridBtn = document.getElementById("grid-toggle");
  if (themeIco) themeIco.textContent = theme === "dark" ? "\u2600" : "\u263E";
  if (gridIco) gridIco.textContent = "\u25A6";
  if (gridBtn) gridBtn.classList.toggle("active", grid === "on");
}

/* Apply saved theme BEFORE first paint to prevent flash */
(function applySavedTheme() {
  const t = localStorage.getItem("tm-theme") || "dark";
  const g = localStorage.getItem("tm-grid") || "off";
  document.documentElement.setAttribute("data-theme", t);
  document.documentElement.setAttribute("data-grid", g);
})();

function fmtNotifTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function notifIcon(type) {
  const icons = {
    TICKET_CREATED: "&#128196;",
    STATUS_CHANGED: "&#128640;",
    ASSIGNED: "&#128100;",
    MENTIONED: "&#128172;",
    COMMENT_ADDED: "&#128172;",
    SPRINT_CHANGED: "&#9889;",
    PROJECT_INVITE: "&#127873;",
    MEMBER_ADDED: "&#128101;",
  };
  return icons[type] || "&#128276;";
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
