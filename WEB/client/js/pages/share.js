import { api } from "../api.js";
import { navigate } from "../main.js";
import {
  esc, statusPill, priorityPill, avatarHtml, fmtDate, sanitizeDesc, descToEditorHtml,
  TYPE_LABELS,
} from "../ui.js";
import { actText } from "./board.js";
import { t } from "../i18n.js";

// Public, read-only view of one shared ticket. Works without a session (LINK
// mode); in ACCOUNT mode the API answers 401 and we send the visitor to log in.
export async function renderShare(root, token) {
  root.innerHTML = `<div class="share-page"><div class="spinner"></div></div>`;
  let data;
  try {
    data = await api.get(`/share/${encodeURIComponent(token)}`);
  } catch (err) {
    if (err.status === 401) {
      navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    root.innerHTML = `
      <div class="share-page">
        <h1>${t("share.unavailable")}</h1>
        <p class="share-note">${esc(err.message || t("share.invalid"))}</p>
      </div>`;
    return;
  }

  const tk = data.ticket;
  const comments = data.comments.map((c) => `
    <li class="comment-item">
      ${avatarHtml(c.authorName || t("share.unknown"))}
      <div class="comment-body">
        <div class="comment-meta"><b>${esc(c.authorName || t("share.unknown"))}</b><span class="act-when">${fmtDate(c.createdAt)}</span></div>
        <div class="comment-text">${commentHtml(c.body)}</div>
      </div>
    </li>`).join("");
  const activity = [...data.activity].reverse().map((ev) => `
    <li class="activity-item">
      ${avatarHtml(ev.actorName || t("share.someone"))}
      <div class="act-body">
        <div class="act-text"><b>${esc(ev.actorName || t("share.someone"))}</b> ${actText(ev)}</div>
        <div class="act-when">${fmtDate(ev.createdAt)}</div>
      </div>
    </li>`).join("");

  root.innerHTML = `
    <div class="share-page">
      <div class="share-banner">${t("share.banner")}${data.viewer.signedIn ? "" : ` &middot; <a href="/login?next=${encodeURIComponent(location.pathname)}" data-nav>${t("share.signIn")}</a>`}
        ${data.viewer.isMember ? ` &middot; <a href="/projects/${encodeURIComponent(data.projectId)}?task=${encodeURIComponent(data.taskId)}" data-nav>${t("share.openBoard")}</a>` : ""}
      </div>
      <div class="share-head">
        <span class="prefix-chip">${esc(tk.projectPrefix)}</span>
        <span class="ticket-id">${esc(tk.ticketId)}</span>
        ${statusPill(tk.status)} ${priorityPill(tk.priority)}
        <span class="share-type">${esc(TYPE_LABELS[tk.type] || tk.type)}</span>
      </div>
      <h1>${esc(tk.title)}</h1>
      <p class="share-note">${t("share.meta", { project: esc(tk.projectName), assignee: `<b>${esc(tk.assigneeName || t("common.unassigned"))}</b>`, creator: esc(tk.createdByName || t("share.unknownLower")), date: fmtDate(tk.createdAt) })}</p>
      <div class="share-desc">${tk.description ? descToEditorHtml(tk.description) : `<span class="act-empty">${t("share.noDesc")}</span>`}</div>
      <h2>${t("share.comments", { count: data.comments.length })}</h2>
      <ol class="comment-list">${comments || `<li class="act-empty">${t("share.noComments")}</li>`}</ol>
      <h2>${t("share.activity")}</h2>
      <ol class="activity-list">${activity || `<li class="act-empty">${t("share.noActivity")}</li>`}</ol>
    </div>`;
}

function commentHtml(body) {
  const html = sanitizeDesc(body);
  return html.replace(/\[@([^\]]+)\]\(([^)]+)\)/g, (_m, name) => `<span class="mention">@${name}</span>`);
}
