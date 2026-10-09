import { api } from "../api.js";
import { navigate } from "../main.js";
import {
  esc, statusPill, priorityPill, avatarHtml, fmtDate, sanitizeDesc, descToEditorHtml,
  TYPE_LABELS,
} from "../ui.js";
import { actText } from "./board.js";

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
        <h1>Ticket unavailable</h1>
        <p class="share-note">${esc(err.message || "This link is invalid or sharing has been turned off.")}</p>
      </div>`;
    return;
  }

  const t = data.ticket;
  const comments = data.comments.map((c) => `
    <li class="comment-item">
      ${avatarHtml(c.authorName || "Unknown")}
      <div class="comment-body">
        <div class="comment-meta"><b>${esc(c.authorName || "Unknown")}</b><span class="act-when">${fmtDate(c.createdAt)}</span></div>
        <div class="comment-text">${commentHtml(c.body)}</div>
      </div>
    </li>`).join("");
  const activity = [...data.activity].reverse().map((ev) => `
    <li class="activity-item">
      ${avatarHtml(ev.actorName || "Someone")}
      <div class="act-body">
        <div class="act-text"><b>${esc(ev.actorName || "Someone")}</b> ${actText(ev)}</div>
        <div class="act-when">${fmtDate(ev.createdAt)}</div>
      </div>
    </li>`).join("");

  root.innerHTML = `
    <div class="share-page">
      <div class="share-banner">Read-only shared ticket${data.viewer.signedIn ? "" : ` &middot; <a href="/login?next=${encodeURIComponent(location.pathname)}" data-nav>Sign in</a>`}
        ${data.viewer.isMember ? ` &middot; <a href="/projects/${encodeURIComponent(data.projectId)}?task=${encodeURIComponent(data.taskId)}" data-nav>Open on the board</a>` : ""}
      </div>
      <div class="share-head">
        <span class="prefix-chip">${esc(t.projectPrefix)}</span>
        <span class="ticket-id">${esc(t.ticketId)}</span>
        ${statusPill(t.status)} ${priorityPill(t.priority)}
        <span class="share-type">${esc(TYPE_LABELS[t.type] || t.type)}</span>
      </div>
      <h1>${esc(t.title)}</h1>
      <p class="share-note">${esc(t.projectName)} &middot; Assignee: <b>${esc(t.assigneeName || "Unassigned")}</b>
        &middot; Created by ${esc(t.createdByName || "unknown")} on ${fmtDate(t.createdAt)}</p>
      <div class="share-desc">${t.description ? descToEditorHtml(t.description) : `<span class="act-empty">No description.</span>`}</div>
      <h2>Comments (${data.comments.length})</h2>
      <ol class="comment-list">${comments || `<li class="act-empty">No comments.</li>`}</ol>
      <h2>Activity</h2>
      <ol class="activity-list">${activity || `<li class="act-empty">No activity yet.</li>`}</ol>
    </div>`;
}

function commentHtml(body) {
  const html = sanitizeDesc(body);
  return html.replace(/\[@([^\]]+)\]\(([^)]+)\)/g, (_m, name) => `<span class="mention">@${name}</span>`);
}
