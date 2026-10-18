import { api } from "./api.js";
import { state } from "./main.js";
import {
  esc, fmtDate, openModal, toast, sanitizeDesc, isEmptyDesc, statusPill, priorityPill,
  STATUS_LABELS, TYPE_LABELS, PRIORITY_LABELS,
} from "./ui.js";
import { t as tl, locale } from "./i18n.js";

// PDF export = a print-styled copy of the data in #print-root + the browser's own
// "Save as PDF". No library; charts are copied as images so they look like the screen.

/* ---------- Dialog ---------- */

function fieldHtml(f) {
  if (f.kind === "single") {
    const opts = f.noAll ? f.options : [{ value: "", label: f.allLabel || tl("pdf.all") }, ...f.options];
    return `
      <label class="pdf-field">
        <span class="pdf-label">${esc(f.label)}</span>
        <select data-key="${esc(f.key)}">
          ${opts.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(f.value ?? "") ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
        </select>
      </label>`;
  }
  const picked = new Set(f.defaults ?? []);
  const all = picked.size === 0;
  return `
    <fieldset class="pdf-field" data-key="${esc(f.key)}">
      <legend class="pdf-label">${esc(f.label)}</legend>
      <div class="pdf-opts">
        <label class="pdf-opt pdf-opt-all"><input type="checkbox" data-all${all ? " checked" : ""} /> ${tl("pdf.all")}</label>
        ${f.options.map((o) => `<label class="pdf-opt"><input type="checkbox" value="${esc(o.value)}"${picked.has(o.value) ? " checked" : ""} /> ${esc(o.label)}</label>`).join("")}
      </div>
    </fieldset>`;
}

const PAPERS = ["A4", "A3", "A5", "letter", "legal", "full"];
const paperField = () => {
  let saved = "A4";
  try { saved = localStorage.getItem("tm-pdf-paper") || "A4"; } catch { /* storage unavailable */ }
  return {
    key: "paper", kind: "single", noAll: true, label: tl("pdf.paper"),
    value: PAPERS.includes(saved) ? saved : "A4",
    options: PAPERS.map((p) => ({ value: p, label: tl(`pdf.paper.${p}`) })),
  };
};

/**
 * A "Paper size" choice is always added; onExport gets it as values.paper.
 * fields: { key, label, kind: "multi" | "single", options: [{ value, label }], defaults?, value? }
 * onExport receives { key: string[] | null (= all) | string ("" = all) }.
 */
export function openExportDialog({ title, fields, onExport }) {
  fields = [...fields, paperField()];
  openModal({
    title: esc(title),
    body: `
      <form class="pdf-form">
        ${fields.map(fieldHtml).join("")}
        <p class="pdf-hint">${tl("pdf.hint")}</p>
        <div class="modal-actions">
          <span class="right">
            <button type="submit" class="btn">${tl("pdf.create")}</button>
            <button type="button" class="btn ghost" data-cancel>${tl("common.cancel")}</button>
          </span>
        </div>
      </form>`,
    onMount(el, close) {
      const form = el.querySelector("form");
      el.querySelector("[data-cancel]").addEventListener("click", close);
      // "All" and specific choices exclude each other; never leave a group empty.
      for (const set of form.querySelectorAll("fieldset")) {
        const all = set.querySelector("[data-all]");
        const items = [...set.querySelectorAll("input[value]")];
        set.addEventListener("change", (e) => {
          if (e.target === all) {
            if (all.checked) items.forEach((i) => { i.checked = false; });
            else all.checked = true;
          } else {
            all.checked = !items.some((i) => i.checked);
          }
        });
      }
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const values = {};
        for (const f of fields) {
          if (f.kind === "single") values[f.key] = form.querySelector(`select[data-key="${f.key}"]`).value;
          else {
            const set = form.querySelector(`fieldset[data-key="${f.key}"]`);
            values[f.key] = set.querySelector("[data-all]").checked
              ? null
              : [...set.querySelectorAll("input[value]:checked")].map((i) => i.value);
          }
        }
        try { localStorage.setItem("tm-pdf-paper", values.paper); } catch { /* storage unavailable */ }
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = tl("pdf.preparing");
        try {
          await onExport(values);
          close();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = tl("pdf.create");
          toast(err?.message || tl("pdf.failed"), "err");
        }
      });
    },
  });
}

/* ---------- Print ---------- */

const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** Opens the browser print dialog with one page-broken section per entry: { title, html }. */
export async function printSections(docTitle, sections, paper = "A4") {
  document.getElementById("print-root")?.remove();
  const root = document.createElement("div");
  root.id = "print-root";
  root.setAttribute("data-theme", "light");
  const full = paper === "full";
  if (full) root.classList.add("pr-endless");
  const when = new Date().toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
  const meta = tl("pdf.generated", { date: when, user: state.user?.name || "" });
  root.innerHTML = sections.map((s) => `
    <section class="pr-section">
      <header class="pr-head">
        <div class="pr-kicker">${esc(docTitle)} &middot; ${esc(meta)}</div>
        <h2 class="pr-title">${esc(s.title)}</h2>
      </header>
      ${s.html}
    </section>`).join("");
  document.body.appendChild(root);
  const pageStyle = document.createElement("style");
  pageStyle.id = "print-page-style";
  document.head.appendChild(pageStyle);
  pageStyle.textContent = `@page { size: ${full ? "A4" : paper}; margin: 12mm; }`;
  document.body.classList.add("printing");
  const prevTitle = document.title;
  document.title = `${docTitle} ${today()}`; // becomes the suggested file name
  await Promise.all([...root.querySelectorAll("img")].map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
  if (full) {
    // "Endless" page: one tall page as wide as A4 and as high as the content, for reading on screen.
    // (Chrome caps a page at 200in; anything longer simply continues on a second page.)
    root.classList.add("pr-measure");
    const h = Math.min(Math.ceil(root.scrollHeight) + 8, 19000);
    root.classList.remove("pr-measure");
    pageStyle.textContent = `@page { size: 794px ${h}px; margin: 0; }`;
  }
  const done = () => {
    window.removeEventListener("afterprint", done);
    pageStyle.remove();
    root.remove();
    document.body.classList.remove("printing");
    document.title = prevTitle;
  };
  window.addEventListener("afterprint", done);
  window.print();
}

/** HTML of a rendered page (charts as images, interactive controls removed). */
export function snapshotPage(root) {
  const page = root.querySelector(".page");
  const clone = page.cloneNode(true);
  const from = page.querySelectorAll("canvas");
  const to = clone.querySelectorAll("canvas");
  from.forEach((c, i) => {
    const img = document.createElement("img");
    img.className = "pr-chart";
    img.src = c.toDataURL("image/png");
    img.style.aspectRatio = `${c.width} / ${c.height}`;
    to[i].replaceWith(img);
  });
  for (const sel of [".page-head", "#filter-bar", ".bulk-bar", ".chart-toggle", ".panel-footer", "#gh-activity-grid", ".spinner"]) {
    clone.querySelectorAll(sel).forEach((e) => e.remove());
  }
  clone.querySelectorAll(".quick-links").forEach((e) => e.closest(".dash-grid")?.remove());
  return clone.innerHTML;
}

/** Runs fn with chart animations off so a chart is fully drawn the moment it is created. */
export async function withoutAnimation(fn) {
  const prev = window.Chart?.defaults.animation;
  if (window.Chart) window.Chart.defaults.animation = false;
  try { return await fn(); } finally { if (window.Chart) window.Chart.defaults.animation = prev; }
}

export const pdfButton = (id = "pdf-btn") => `<button class="btn sm ghost" id="${id}" title="${tl("pdf.title")}">${tl("pdf.button")}</button>`;

/* ---------- Ticket lists ---------- */

/** Tickets grouped per project as tables. Each ticket: ticketId, title, labels, status, type, priority, dueDate, projectId/Name/Prefix. */
export function ticketTablesHtml(list) {
  if (list.length === 0) return `<p class="pr-empty">${tl("pdf.noTickets")}</p>`;
  const groups = new Map();
  for (const t of list) {
    if (!groups.has(t.projectId)) groups.set(t.projectId, { name: t.projectName, prefix: t.projectPrefix, rows: [] });
    groups.get(t.projectId).rows.push(t);
  }
  return [...groups.values()].map((g) => `
    <h3 class="pr-sub"><span class="prefix-chip">${esc(g.prefix)}</span> ${esc(g.name)} <small>(${g.rows.length})</small></h3>
    <table class="data pr-table">
      <thead><tr>
        <th>${tl("mt.colTicket")}</th><th>${tl("mt.colTitle")}</th><th>${tl("mt.colLabels")}</th>
        <th>${tl("mt.colStatus")}</th><th>${tl("mt.colType")}</th><th>${tl("mt.colPriority")}</th><th>${tl("pdf.due")}</th>
      </tr></thead>
      <tbody>${g.rows.map((t) => `<tr>
        <td class="ticket-id">${esc(t.ticketId)}</td>
        <td>${esc(t.title)}</td>
        <td>${(t.labels ?? []).map((l) => `<span class="label-chip">${esc(l)}</span>`).join(" ")}</td>
        <td>${esc(STATUS_LABELS[t.status])}</td>
        <td>${esc(TYPE_LABELS[t.type])}</td>
        <td>${esc(PRIORITY_LABELS[t.priority])}</td>
        <td>${esc(t.dueDate || "")}</td>
      </tr>`).join("")}</tbody>
    </table>`).join("");
}

/* ---------- Single tickets ---------- */

function commentHtml(c) {
  let body = sanitizeDesc(c.body).replace(/\[@([^\]]+)\]\(([^)]+)\)/g, (_m, name) => `<b>@${name}</b>`);
  if (!body.trim()) body = "";
  return `<li class="pr-comment"><div class="pr-comment-meta"><b>${esc(c.authorName || tl("bd.unknown"))}</b> <span>${fmtDate(c.createdAt)}</span></div><div class="pr-rich">${body}</div></li>`;
}

function ticketHtml({ task, project, comments, events, actText }) {
  const assignee = project.members.find((m) => m.userId === task.assigneeId)?.name;
  const sprint = project.sprints?.find((s) => s.id === task.sprintId);
  const rows = [
    [tl("mt.colStatus"), statusPill(task.status)],
    [tl("mt.colType"), esc(TYPE_LABELS[task.type])],
    [tl("mt.colPriority"), priorityPill(task.priority)],
    [tl("pdf.assignee"), esc(assignee || tl("bd.unassigned"))],
    [tl("pdf.sprint"), esc(sprint ? `${sprint.sprintId} - ${sprint.name}` : tl("bd.backlog"))],
    [tl("pdf.due"), esc(task.dueDate || "-")],
    [tl("mt.colLabels"), (task.labels ?? []).map((l) => `<span class="label-chip">${esc(l)}</span>`).join(" ") || "-"],
    [tl("pdf.created"), fmtDate(task.createdAt)],
  ];
  const desc = task.description && !isEmptyDesc(sanitizeDesc(task.description))
    ? (/<[a-zA-Z]|<\//.test(task.description) ? sanitizeDesc(task.description) : esc(task.description).replaceAll("\n", "<br>"))
    : `<span class="pr-none">${tl("pdf.noDescription")}</span>`;
  return `
    <p class="pr-project"><span class="prefix-chip">${esc(project.prefix)}</span> ${esc(project.name)}</p>
    <dl class="pr-meta-grid">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
    <h3 class="pr-sub">${tl("pdf.description")}</h3>
    <div class="pr-rich">${desc}</div>
    <h3 class="pr-sub">${tl("bd.comments")} <small>(${comments.length})</small></h3>
    ${comments.length ? `<ul class="pr-list">${comments.map(commentHtml).join("")}</ul>` : `<p class="pr-none">${tl("pdf.none")}</p>`}
    <h3 class="pr-sub">${tl("bd.activity")}</h3>
    ${events.length ? `<ul class="pr-list">${events.map((ev) => `<li class="pr-event"><b>${esc(ev.actorName || tl("bd.someone"))}</b> ${actText(ev)} <span>${fmtDate(ev.createdAt)}</span></li>`).join("")}</ul>` : `<p class="pr-none">${tl("pdf.none")}</p>`}`;
}

/** One page (or more) per ticket. refs: [{ projectId, id }]. */
export function exportTicketsPdf(refs) {
  openExportDialog({
    title: tl("pdf.title"),
    fields: [],
    onExport: ({ paper }) => buildTicketsPdf(refs, paper),
  });
}

async function buildTicketsPdf(refs, paper) {
  try {
    const { actText } = await import("./pages/board.js");
    const byProject = new Map();
    for (const r of refs) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r.id]);
    const sections = [];
    for (const [projectId, ids] of byProject) {
      const pid = encodeURIComponent(projectId);
      const [project, tasks] = await Promise.all([api.get(`/projects/${pid}`), api.get(`/projects/${pid}/tasks`)]);
      for (const id of ids) {
        const task = tasks.find((x) => x.id === id);
        if (!task) continue;
        const base = `/projects/${pid}/tasks/${encodeURIComponent(id)}`;
        const [comments, events] = await Promise.all([
          api.get(`${base}/comments`).catch(() => []),
          api.get(`${base}/events`).catch(() => []),
        ]);
        sections.push({ title: `${task.ticketId} - ${task.title}`, html: ticketHtml({ task, project, comments, events, actText }) });
      }
    }
    if (sections.length === 0) throw new Error(tl("pdf.noTickets"));
    await printSections(refs.length === 1 ? sections[0].title : tl("pdf.doc.tickets"), sections, paper);
  } catch (err) {
    toast(err?.message || tl("pdf.failed"), "err");
    throw err;
  }
}
