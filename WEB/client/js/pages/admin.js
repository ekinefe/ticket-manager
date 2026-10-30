import { state } from "../main.js";
import { t as tl } from "../i18n.js";
import { renderUsersTab } from "./admin/users.js";
import { renderProjectsTab } from "./admin/projects.js";
import { renderAccessTab } from "./admin/access.js";
import { renderSettingsTab } from "./admin/settings.js";

export async function renderAdmin(root, section = "users") {
  if (!requireAdminAccess(root)) return;

  root.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>${tl("adm.title")}</h1></div>
      <nav class="tabs">
        <a class="tab${section === "users" ? " active" : ""}" href="/admin/users" data-nav>${tl("adm.tabUsers")}</a>
        <a class="tab${section === "projects" ? " active" : ""}" href="/admin/projects" data-nav>${tl("adm.tabProjects")}</a>
        ${state.user.role === "SUPER_ADMIN" ? `<a class="tab${section === "access" ? " active" : ""}" href="/admin/access" data-nav>${tl("adm.tabAccess")}</a>` : ""}
        ${state.user.role === "SUPER_ADMIN" ? `<a class="tab${section === "settings" ? " active" : ""}" href="/admin/settings" data-nav>${tl("adm.tabSystem")}</a>` : ""}
      </nav>
      <div id="admin-body"><div class="spinner"></div></div>
    </div>`;

  const body = root.querySelector("#admin-body");
  if (section === "projects") await renderProjectsTab(body);
  else if (section === "settings") await renderSettingsTab(body);
  else if (section === "access") await renderAccessTab(body);
  else await renderUsersTab(body);
}

function requireAdminAccess(root) {
  if (state.user.role === "USER") {
    root.innerHTML = `
      <div class="page">
        <h1>${tl("adm.title")}</h1>
        <div class="empty-note">${tl("adm.noAccess")}</div>
      </div>`;
    return false;
  }
  return true;
}
