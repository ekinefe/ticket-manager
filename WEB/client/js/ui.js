export const STATUSES = ["TODO", "IN_PROGRESS", "UNDER_REVIEW", "MERGED", "DEPLOYED", "TEST", "DONE"];

export const STATUS_COLORS = {
  TODO: "#737373",
  IN_PROGRESS: "#286EB4",
  UNDER_REVIEW: "#C88214",
  MERGED: "#783CA0",
  DEPLOYED: "#1E8C5A",
  TEST: "#CD5F23",
  DONE: "#236E37",
};

export const STATUS_LABELS = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  UNDER_REVIEW: "Under Review",
  MERGED: "Merged",
  DEPLOYED: "Deployed",
  TEST: "Test",
  DONE: "Done",
};

export function canTransition(from, to) {
  if (from === to) return true; // reorder within a column
  return true; // free movement both directions; accidental drags can be undone
}

export function allowedTargets(from) {
  return STATUSES.filter((s) => canTransition(from, s));
}

export function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const AVATAR_COLORS = ["#964826", "#286EB4", "#C88214", "#783CA0", "#1E8C5A", "#CD5F23", "#236E37", "#5B6ABF"];

export function initials(name) {
  return (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function avatarHtml(name, id, cls = "") {
  let h = 0;
  for (const ch of String(id || name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return `<span class="avatar ${cls}" style="background:${color}">${esc(initials(name))}</span>`;
}

export function statusPill(status, count) {
  const n = Number(count);
  const label = STATUS_LABELS[status] || status;
  return `<span class="status-pill" style="background:${STATUS_COLORS[status] || "#737373"}">${esc(label)}${Number.isFinite(n) ? ` · ${n}` : ""}</span>`;
}

export function roleChip(role) {
  if (!role) return "";
  const cls = role === "SUPER_ADMIN" ? "role-super" : role === "ADMIN" ? "role-admin" : "role-member";
  const label = role === "SUPER_ADMIN" ? "Super Admin" : role;
  return `<span class="role-chip ${cls}">${esc(label)}</span>`;
}

export function fmtDate(ms) {
  if (!ms) return "-";
  return new Date(Number(ms)).toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

/* ---------- Ticket type / priority / branch ---------- */

export const TASK_TYPES = ["TASK", "BUG"];
export const TYPE_LABELS = { TASK: "Task", BUG: "Bug" };

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
export const PRIORITY_LABELS = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" };
export const PRIORITY_COLORS = { LOW: "#8a8a8a", MEDIUM: "#286EB4", HIGH: "#C88214", URGENT: "#C0392B" };

export function priorityPill(priority) {
  const p = PRIORITY_LABELS[priority] ? priority : "MEDIUM";
  const c = PRIORITY_COLORS[p];
  return `<span class="priority-pill" style="color:${c};background:${c}14">${esc(PRIORITY_LABELS[p])}</span>`;
}

// BUG -> hotfix/<ticketId>, TASK -> feature/<ticketId>
export function branchName(t) {
  if (!t?.ticketId) return "";
  return `${t.type === "BUG" ? "hotfix" : "feature"}/${t.ticketId}`;
}

/* ---------- Rich-text description helpers ---------- */

const DESC_ALLOWED_TAGS = new Set([
  "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL",
  "UL", "OL", "LI", "BR", "P", "DIV", "H2", "H3",
  "CODE", "PRE", "BLOCKQUOTE", "A", "SPAN",
  // Embedded media; src validated against /media/uploads/* below.
  "IMG", "VIDEO",
]);

// Tags allowed to embed uploaded media; src must point at /media/uploads/*.
const MEDIA_TAGS = new Set(["IMG", "VIDEO"]);
const MEDIA_ATTRS = ["src", "alt", "controls", "playsinline"];

function safeMediaSrc(value) {
  return typeof value === "string" && value.startsWith("/media/uploads/");
}

// Allowlist-based sanitizer: strips scripts, event handlers, unknown tags/attrs.
export function sanitizeDesc(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const walk = (node) => {
    for (const el of [...node.children]) {
      walk(el);
      if (!DESC_ALLOWED_TAGS.has(el.tagName)) {
        el.replaceWith(...el.childNodes);
        continue;
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (el.tagName === "A" && name === "href") continue;
        if (MEDIA_TAGS.has(el.tagName) && MEDIA_ATTRS.includes(name)) continue;
        el.removeAttribute(attr.name);
      }
      if (el.tagName === "A") {
        const href = el.getAttribute("href") || "";
        if (/^https?:/i.test(href)) {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        } else {
          el.removeAttribute("href");
        }
      }
      if (MEDIA_TAGS.has(el.tagName)) {
        if (!safeMediaSrc(el.getAttribute("src"))) {
          el.remove();
        } else if (el.tagName === "VIDEO") {
          el.setAttribute("controls", "");
          el.setAttribute("playsinline", "");
        }
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// Old tickets hold plain text; anything that looks like markup (incl. multi-letter
// tags such as <img>/<video>/<pre>) is treated as HTML and sanitized.
export function descToEditorHtml(value) {
  const v = String(value ?? "");
  if (/<[a-zA-Z]|<\//.test(v)) return sanitizeDesc(v);
  const frag = document.createElement("div");
  frag.textContent = v;
  return frag.innerHTML.replaceAll("\n", "<br>");
}

export function isEmptyDesc(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html || "");
  return tmp.textContent.trim() === "" && !tmp.querySelector("img,video,li,blockquote,pre,a");
}

/* ---------- Toast ---------- */
export function toast(message, type = "") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 260);
  }, type === "err" ? 5000 : 3200);
}

/* ---------- Modal ---------- */
export function openModal({ title = "", body = "", onMount, wide = false } = {}) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>${title}</h2>
          <button class="modal-close" aria-label="Close" title="Close">&times;</button>
        </div>
        <div class="modal-body">${body}</div>
      </div>
    </div>`;
  const overlay = root.firstElementChild;
  const close = () => { root.innerHTML = ""; };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".modal-close").addEventListener("click", close);
  const escHandler = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
  const modalEl = overlay.querySelector(".modal");
  if (onMount) onMount(modalEl, close);
  return { el: modalEl, close };
}
