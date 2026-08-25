import { api } from "../api.js";
import { navigate, requireAuth, state } from "../main.js";
import {
  STATUSES, STATUS_COLORS, STATUS_LABELS, canTransition,
  esc, avatarHtml, statusPill, openModal, toast, fmtDate,
  sanitizeDesc, descToEditorHtml, isEmptyDesc,
  TASK_TYPES, TYPE_LABELS, PRIORITIES, PRIORITY_LABELS, priorityPill, branchName,
} from "../ui.js";

let project = null;
let myRole = "MEMBER";
let tasks = [];
let filterText = "";
let filterAssignee = "";

export async function renderBoard(root, projectId) {
  if (!requireAuth(`/projects/${projectId}`)) return;
  root.innerHTML = `<div class="spinner"></div>`;

  try {
    [project, tasks] = await Promise.all([
      api.get(`/projects/${projectId}`),
      api.get(`/projects/${projectId}/tasks`),
    ]);
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }

  const isSuper = state.user.role === "SUPER_ADMIN";
  const cachedProj = Array.isArray(state.projectsCache)
    ? state.projectsCache.find((p) => p.id === projectId) : null;
  myRole = isSuper || cachedProj?.role === "ADMIN" ? "ADMIN" : "MEMBER";

  drawShell(root);
}

async function renderMembers(root, projectId) {
  if (!requireAuth(`/projects/${projectId}/members`)) return;
  try {
    project = await api.get(`/projects/${projectId}`);
  } catch (err) {
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }
  const isSuper = state.user.role === "SUPER_ADMIN";
  const cachedProj = Array.isArray(state.projectsCache)
    ? state.projectsCache.find((p) => p.id === projectId) : null;
  myRole = isSuper || cachedProj?.role === "ADMIN" ? "ADMIN" : "MEMBER";

  root.innerHTML = `
    ${headHtml("members")}
    <div class="page" style="max-width:860px">
      ${myRole === "ADMIN" ? `
      <div class="hint-card">
        <span>You are a project admin. Manage settings, invitations and deletion from the <strong>Admin Panel</strong>.</span>
        <a class="btn sm ghost" href="/admin/users" data-nav>Open Admin Panel</a>
      </div>` : ""}
      <div class="table-card">
        <table class="data">
          <thead><tr><th>Name</th><th>E-mail</th><th>Project role</th></tr></thead>
          <tbody>
            ${project.members.map((m) => `
              <tr>
                <td style="display:flex;align-items:center;gap:10px">${avatarHtml(m.name, m.userId)} ${esc(m.name)}</td>
                <td>${esc(m.email)}</td>
                <td>${m.role === "ADMIN"
                  ? `<span class="role-chip role-admin">ADMIN</span>`
                  : `<span class="role-chip role-member">MEMBER</span>`}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
  bindTabs();
}
export { renderMembers as renderMembersTab };

/* ---------------- Shell ---------------- */

function headHtml(activeTab) {
  return `
    <div class="proj-head">
      <div class="proj-title-row">
        <h1>${esc(project.name)}</h1>
        <span class="prefix-chip">${esc(project.prefix)}</span>
        ${myRole === "ADMIN" ? `<span class="role-chip role-admin">You are admin</span>` : ""}
      </div>
      <nav class="tabs">
        <button class="tab ${activeTab === "board" ? "active" : ""}" data-tab="board">Board (${tasks.length})</button>
        <button class="tab ${activeTab === "members" ? "active" : ""}" data-tab="members">Members (${project.members.length})</button>
      </nav>
    </div>`;
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigate(btn.dataset.tab === "members"
        ? `/projects/${project.id}/members`
        : `/projects/${project.id}`);
    });
  });
}

function drawShell(root) {
  root.innerHTML = `
    ${headHtml("board")}
    <div class="toolbar">
      <input type="text" class="search" id="filter-text" placeholder="Search tickets..." value="${esc(filterText)}" />
      <select id="filter-assignee">
        <option value="">All assignees</option>
        ${project.members.map((m) => `<option value="${esc(m.userId)}">${esc(m.name)}</option>`).join("")}
      </select>
      <span style="flex:1"></span>
      <button class="btn sm" id="new-task-btn">+ New ticket</button>
    </div>
    <div class="board-scroll">
      <div class="board">
        ${STATUSES.map((s) => columnHtml(s)).join("")}
      </div>
    </div>`;

  bindTabs();
  document.getElementById("new-task-btn").addEventListener("click", () => taskModal(null));

  const searchEl = document.getElementById("filter-text");
  searchEl.addEventListener("input", () => { filterText = searchEl.value.toLowerCase(); refreshColumns(); });

  const assigneeEl = document.getElementById("filter-assignee");
  assigneeEl.value = filterAssignee;
  assigneeEl.addEventListener("change", () => { filterAssignee = assigneeEl.value; refreshColumns(); });

  bindDragAndDrop();
  refreshColumns();
}

function visibleTasks(status) {
  return tasks
    .filter((t) => t.status === status)
    .filter((t) => !filterText ||
      t.title.toLowerCase().includes(filterText) ||
      t.ticketId.toLowerCase().includes(filterText))
    .filter((t) => !filterAssignee || t.assigneeId === filterAssignee)
    .sort((a, b) => a.position - b.position);
}

function memberById(id) {
  return project.members.find((m) => m.userId === id) || null;
}

// Members may only drag/edit tickets assigned to them or created by them;
// project admins (and super admins) can modify anything.
function canModifyTask(t) {
  if (myRole === "ADMIN") return true;
  return t.assigneeId === state.user.id || t.createdBy === state.user.id;
}

function columnHtml(status) {
  const list = visibleTasks(status);
  return `
    <section class="column" data-status="${status}">
      <header class="col-head">
        <span class="col-dot" style="background:${STATUS_COLORS[status]}"></span>
        <span class="col-label">${STATUS_LABELS[status]}</span>
        <span class="col-count" data-count>${list.length}</span>
        <button class="col-add" data-add="${status}" title="Add ticket here">+</button>
      </header>
      <div class="col-body" data-body="${status}"></div>
    </section>`;
}

function cardHtml(t) {
  const assignee = memberById(t.assigneeId);
  const movable = canModifyTask(t);
  return `
    <article class="card ${movable ? "" : "locked"}" draggable="${movable}" data-id="${esc(t.id)}">
      <div class="row">
        <span class="ticket-id">${esc(t.ticketId)}</span>
        <span class="card-meta">
          ${priorityPill(t.priority)}
          <span class="assignee">
            ${assignee
              ? `${avatarHtml(assignee.name, assignee.userId)}<span class="nm">${esc(assignee.name.split(" ")[0])}</span>`
              : `<span class="nm">Unassigned</span>`}
          </span>
        </span>
      </div>
      <p class="title">${esc(t.title)}</p>
      ${t.ticketId ? `<div class="branch-line"><span class="branch-ico">&#9123;</span>${esc(branchName(t))}</div>` : ""}
    </article>`;
}

function refreshColumns() {
  document.querySelectorAll(".column").forEach((col) => {
    const status = col.dataset.status;
    const body = col.querySelector("[data-body]");
    body.innerHTML = "";
    const list = visibleTasks(status);
    if (list.length === 0) {
      body.innerHTML = `<div class="col-empty">No tickets</div>`;
    } else {
      for (const t of list) {
        body.insertAdjacentHTML("beforeend", cardHtml(t));
      }
    }
    col.querySelector("[data-count]").textContent = String(list.length);
  });

  document.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => card.classList.add("dragging"));
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      clearDropMarkers();
    });
    card.addEventListener("click", () => {
      const t = tasks.find((x) => x.id === card.dataset.id);
      if (t) taskModal(t);
    });
  });

  document.querySelectorAll(".col-add").forEach((btn) =>
    btn.addEventListener("click", () => taskModal(null, btn.dataset.add))
  );
}

/* ---------------- Drag & drop ---------------- */

function clearDropMarkers() {
  document.querySelectorAll(".column").forEach((c) => c.classList.remove("drop-ok", "drop-bad"));
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
}

function insertionIndex(body, clientY, draggedId) {
  const cards = [...body.querySelectorAll(".card")].filter((c) => c.dataset.id !== draggedId);
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return { idx: i, beforeTaskId: cards[i].dataset.id };
  }
  return { idx: cards.length, beforeTaskId: null };
}

function showIndicator(body, idx, ok) {
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
  const ind = document.createElement("div");
  ind.className = "drop-indicator";
  ind.style.background = ok ? "var(--accent)" : "var(--danger)";
  const empty = body.querySelector(".col-empty");
  if (!empty && body.children.length === 0) {
    body.appendChild(ind);
    return;
  }
  if (idx >= body.children.length || (empty && body.children.length === 1)) {
    body.appendChild(ind);
  } else {
    body.insertBefore(ind, body.children[idx]);
  }
}

function bindDragAndDrop() {
  document.querySelectorAll(".column").forEach((col) => {
    const status = col.dataset.status;
    const body = col.querySelector("[data-body]");
    let lastOk = false;

    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
      const draggedId = e.dataTransfer.types.includes("text/plain") ? draggingId : null;
      if (!draggedId) return;
      const dragged = tasks.find((t) => t.id === draggedId);
      if (!dragged) return;

      const sameColumn = dragged.status === status;
      const legal = sameColumn || canTransition(dragged.status, status);
      // Same-column moves are always allowed; cross-column must pass transition rules.
      lastOk = legal;
      e.dataTransfer.dropEffect = legal ? "move" : "none";
      col.classList.toggle("drop-ok", legal);
      col.classList.toggle("drop-bad", !legal);
      const { idx } = insertionIndex(body, e.clientY, draggedId);
      showIndicator(body, idx, legal);
    });

    col.addEventListener("dragleave", (e) => {
      if (!col.contains(e.relatedTarget)) {
        col.classList.remove("drop-ok", "drop-bad");
      }
    });

    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      clearDropMarkers();
      const draggedId = e.dataTransfer.getData("text/plain");
      const dragged = tasks.find((t) => t.id === draggedId);
      if (!dragged) return;

      const { beforeTaskId } = insertionIndex(body, e.clientY, draggedId);
      const sameColumn = dragged.status === status;
      if (!sameColumn && !canTransition(dragged.status, status)) {
        toast(`Illegal move: ${STATUS_LABELS[dragged.status]} \u2192 ${STATUS_LABELS[status]}`, "err");
        return;
      }
      if (sameColumnOrderUnchanged(dragged, status, beforeTaskId)) return;

      await moveTask(dragged, status, beforeTaskId);
    });
  });
}

// True when a same-column drop lands back in exactly the same spot.
function sameColumnOrderUnchanged(task, status, beforeTaskId) {
  if (task.status !== status) return false;
  const ordered = visibleTasks(status);
  const rest = ordered.filter((t) => t.id !== task.id);
  const at = beforeTaskId ? rest.findIndex((t) => t.id === beforeTaskId) : rest.length;
  const next = [...rest.slice(0, at), task, ...rest.slice(at)];
  return next.map((t) => t.id).join("|") === ordered.map((t) => t.id).join("|");
}

async function moveTask(task, newStatus, beforeTaskId) {
  const oldStatus = task.status;
  // Optimistic local reorder
  removeLocal(task.id);
  const siblings = tasks
    .filter((t) => t.status === newStatus)
    .sort((a, b) => a.position - b.position);
  task.status = newStatus;
  task.position = beforeTaskId
    ? localNeighborPosition(siblings, beforeTaskId)
    : (siblings.at(-1)?.position ?? 0) + 1;
  tasks.push(task);

  try {
    const updated = await api.patch(`/projects/${project.id}/tasks/${task.id}`, {
      status: newStatus,
      beforeTaskId: beforeTaskId || undefined,
    });
    Object.assign(task, updated);
    if (oldStatus !== newStatus) {
      toast(`${task.ticketId} moved to ${STATUS_LABELS[newStatus]}`, "ok");
    }
  } catch (err) {
    toast(err.message, "err");
    task.status = oldStatus;
    try {
      tasks = await api.get(`/projects/${project.id}/tasks`);
    } catch { /* keep optimistic state */ }
  }
  refreshColumns();
}

function localNeighborPosition(siblings, beforeTaskId) {
  const idx = siblings.findIndex((t) => t.id === beforeTaskId);
  if (idx === -1) return (siblings.at(-1)?.position ?? 0) + 1;
  const prev = siblings[idx - 1]?.position ?? siblings[0].position - 1;
  return (prev + siblings[idx].position) / 2;
}

function removeLocal(id) {
  tasks = tasks.filter((t) => t.id !== id);
}

// Track dragged card id (dataTransfer.types is all we get during dragover)
document.addEventListener("dragstart", (e) => {
  if (e.target.classList?.contains("card")) draggingId = e.target.dataset.id;
});
let draggingId = null;

/* ---------------- Task modal ---------------- */

function assigneeOptions(selectedId) {
  return [`<option value="">Unassigned</option>`]
    .concat(project.members.map((m) =>
      `<option value="${esc(m.userId)}" ${m.userId === selectedId ? "selected" : ""}>${esc(m.name)}</option>`))
    .join("");
}

function taskModal(task, presetStatus = "TODO") {
  const isEdit = Boolean(task);
  const mayEdit = !isEdit || canModifyTask(task);
  const dis = mayEdit ? "" : "disabled";
  const creator = isEdit ? memberById(task.createdBy) : null;

  openModal({
    wide: true,
    title: !isEdit
      ? `New ticket`
      : `<span class="ticket-id">${esc(task.ticketId)}</span> ${mayEdit ? "Edit ticket" : "Ticket details"}`,
    body: `
      <div id="task-error" class="form-error hidden"></div>
      <form id="task-form">
        <div class="task-grid">
          <div class="task-left">
            <div class="field">
              <label for="tf-title">Title</label>
              <input id="tf-title" type="text" required ${dis} value="${isEdit ? esc(task.title) : ""}" />
            </div>
            <div class="field">
              <label for="tf-desc">Description</label>
              ${mayEdit ? `
              <div class="rte-toolbar" id="tf-desc-toolbar">
                <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
                <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
                <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
                <button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
                <span class="rte-sep"></span>
                <button type="button" data-block="h2" title="Heading">H2</button>
                <button type="button" data-block="h3" title="Subheading">H3</button>
                <button type="button" data-block="p" title="Paragraph">&para;</button>
                <span class="rte-sep"></span>
                <button type="button" data-cmd="insertUnorderedList" title="Bullet list">&bull; &#8801;</button>
                <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. &#8801;</button>
                <span class="rte-sep"></span>
                <button type="button" id="tf-link" title="Insert link">&#128279;</button>
                <button type="button" id="tf-code" title="Code block">&lt;/&gt;</button>
                <button type="button" id="tf-image" title="Insert image">&#128444;</button>
                <button type="button" id="tf-video" title="Insert video">&#127916;</button>
                <span class="rte-sep"></span>
                <button type="button" data-cmd="removeFormat" title="Clear formatting">&#10539;</button>
              </div>` : ""}
              <input type="file" id="tf-media-input" hidden />
              <div id="tf-desc" class="rte" contenteditable="${mayEdit}" aria-label="Description">${descToEditorHtml(isEdit ? task.description : "")}</div>
            </div>
            <div class="modal-actions">
              ${isEdit && mayEdit && myRole === "ADMIN" ? `<button type="button" class="btn danger" id="tf-delete">Delete</button>` : ""}
              ${!mayEdit ? `<span class="ro-note">Read-only &mdash; only the assignee, the ticket creator or a project admin can modify this ticket.</span>` : ""}
              <span class="right">
                <button type="button" class="btn ghost" data-close>Cancel</button>
                ${mayEdit ? `<button type="submit" class="btn" id="tf-save">${isEdit ? "Save changes" : "Create ticket"}</button>` : ""}
              </span>
            </div>
            ${isEdit ? `
            <div class="comments-block">
              <div class="activity-head">Comments</div>
              <div class="comment-box">
                <textarea id="tf-comment-input" rows="2" placeholder="Write a comment&hellip; type @ to mention someone (Ctrl+Enter to send)"></textarea>
                <button type="button" class="btn sm" id="tf-comment-send">Send</button>
                <div id="tf-mention-menu" class="mention-menu hidden"></div>
              </div>
              <ol id="tf-comments" class="comment-list"><li class="act-empty">Loading&hellip;</li></ol>
            </div>` : ""}
          </div>
          <div class="task-right">
            <div class="detail-card">
              <div class="detail-row">
                <span class="k">Project</span>
                <span class="v">${esc(project.name)}&nbsp;<span class="prefix-chip">${esc(project.prefix)}</span></span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">Ticket ID</span>
                <span class="v"><span class="ticket-id">${esc(task.ticketId)}</span></span>
              </div>` : ""}
              <div class="detail-row">
                <span class="k">Type${isEdit && myRole !== "ADMIN" ? " (admin only)" : ""}</span>
                <span class="v">
                  <select id="tf-type" ${!isEdit || myRole === "ADMIN" ? dis : "disabled"}>
                    ${TASK_TYPES.map((v) => `<option value="${v}" ${v === (isEdit ? task.type : "TASK") ? "selected" : ""}>${TYPE_LABELS[v]}</option>`).join("")}
                  </select>
                </span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">Branch</span>
                <span class="v"><code class="branch-chip" id="tf-branch" title="Click to copy">${esc(branchName(task))}</code></span>
              </div>` : ""}
              <div class="detail-row">
                <span class="k">Priority${isEdit && myRole !== "ADMIN" ? " (admin only)" : ""}</span>
                <span class="v">
                  <select id="tf-priority" ${!isEdit || myRole === "ADMIN" ? dis : "disabled"}>
                    ${PRIORITIES.map((v) => `<option value="${v}" ${v === (isEdit ? task.priority : "MEDIUM") ? "selected" : ""}>${PRIORITY_LABELS[v]}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">Status</span>
                <span class="v">
                  <select id="tf-status" ${dis}>
                    ${(isEdit ? allowedTargetList(task.status) : STATUSES.map((s) => ({ value: s }))).map(({ value, label }) =>
                      `<option value="${esc(value)}" ${value === (isEdit ? task.status : presetStatus) ? "selected" : ""}>${esc(label || STATUS_LABELS[value])}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">Assignee${isEdit && mayEdit && myRole !== "ADMIN" ? " (admin only)" : ""}</span>
                <span class="v">
                  <select id="tf-assignee" ${mayEdit && (myRole === "ADMIN" || !isEdit) ? "" : "disabled"}>${assigneeOptions(isEdit ? task.assigneeId : "")}</select>
                </span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">Created by</span>
                <span class="v">${creator ? `${avatarHtml(creator.name, creator.userId)} ${esc(creator.name)}` : "&mdash;"}</span>
              </div>
              <div class="detail-row">
                <span class="k">Created</span>
                <span class="v">${fmtDate(task.createdAt)}</span>
              </div>
              <div class="detail-row">
                <span class="k">Updated</span>
                <span class="v">${fmtDate(task.updatedAt)}</span>
              </div>` : ""}
            </div>
            ${isEdit ? `
            <div class="detail-card activity-card">
              <div class="activity-head">Activity</div>
              <ol id="tf-activity" class="activity-list"><li class="act-empty">Loading&hellip;</li></ol>
            </div>` : ""}
          </div>
        </div>
      </form>`,
    onMount(modalEl, close) {
      modalEl.querySelector("[data-close]").addEventListener("click", close);
      const errBox = modalEl.querySelector("#task-error");
      const form = modalEl.querySelector("#task-form");

      const actList = modalEl.querySelector("#tf-activity");
      if (actList) loadActivity(actList, task.id);
      const cmtList = modalEl.querySelector("#tf-comments");
      if (cmtList) setupComments(modalEl, cmtList, task.id);

      // Branch name follows the selected type; click to copy.
      const typeSel = modalEl.querySelector("#tf-type");
      const branchChip = modalEl.querySelector("#tf-branch");
      if (typeSel && branchChip) {
        typeSel.addEventListener("change", () => {
          branchChip.textContent = `${typeSel.value === "BUG" ? "hotfix" : "feature"}/${task.ticketId}`;
        });
        branchChip.addEventListener("click", () => {
          navigator.clipboard?.writeText(branchChip.textContent)
            .then(() => toast("Branch name copied", "ok"))
            .catch(() => {});
        });
      }

      if (mayEdit) {
        const editor = modalEl.querySelector("#tf-desc");
        const toolbar = modalEl.querySelector("#tf-desc-toolbar");
        document.execCommand("styleWithCSS", false, "false");
        // Prevent toolbar clicks from stealing the text selection.
        toolbar.addEventListener("mousedown", (e) => e.preventDefault());
        toolbar.addEventListener("click", (e) => {
          const btn = e.target.closest("button");
          if (!btn || btn.disabled) return;
          editor.focus();
          if (btn.dataset.cmd) {
            document.execCommand(btn.dataset.cmd, false, null);
          } else if (btn.dataset.block) {
            document.execCommand("formatBlock", false, btn.dataset.block.toUpperCase());
          }
          syncActive();
        });
        modalEl.querySelector("#tf-link").addEventListener("click", () => {
          const url = prompt("Link URL (https://...)");
          if (!url) return;
          editor.focus();
          document.execCommand("createLink", false, url);
          syncActive();
        });
        modalEl.querySelector("#tf-code").addEventListener("click", () => {
          editor.focus();
          const sel = window.getSelection();
          const txt = sel && !sel.isCollapsed ? sel.toString() : "";
          document.execCommand("insertHTML", false, `<pre><code>${esc(txt)}</code></pre><p></p>`);
          syncActive();
        });

        // Media upload: remember caret, pick a file, insert returned /media/ URL.
        const mediaInput = modalEl.querySelector("#tf-media-input");
        let savedRange = null;
        const openPicker = (accept) => {
          const sel = window.getSelection();
          savedRange = sel && sel.rangeCount && editor.contains(sel.anchorNode)
            ? sel.getRangeAt(0).cloneRange() : null;
          mediaInput.accept = accept;
          mediaInput.click();
        };
        modalEl.querySelector("#tf-image").addEventListener("click",
          () => openPicker("image/png,image/jpeg,image/gif,image/webp"));
        modalEl.querySelector("#tf-video").addEventListener("click",
          () => openPicker("video/mp4,video/webm,video/quicktime"));
        mediaInput.addEventListener("change", async () => {
          const file = mediaInput.files?.[0];
          mediaInput.value = "";
          if (!file) return;
          toast(`Uploading ${file.name}...`);
          try {
            const fd = new FormData();
            fd.append("file", file);
            const res = await api.upload(`/projects/${project.id}/media`, fd);
            editor.focus();
            if (savedRange) {
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(savedRange);
            }
            const html = res.type.startsWith("image/")
              ? `<img src="${esc(res.url)}" alt="${esc(file.name)}">`
              : `<video src="${esc(res.url)}" controls playsinline></video>`;
            document.execCommand("insertHTML", false, html + "<p><br></p>");
            ensureTrailingLine();
            syncActive();
            toast(`${file.name} added`, "ok");
          } catch (err) {
            toast(err.message || "Upload failed", "err");
          }
        });

        // Highlight toolbar buttons matching the formatting at the caret.
        const syncActive = () => {
          if (!document.contains(editor)) return;
          const sel = window.getSelection();
          if (!sel || !sel.anchorNode || !editor.contains(sel.anchorNode)) return;
          let block = "";
          try { block = String(document.queryCommandValue("formatBlock")).toLowerCase(); } catch { /* noop */ }
          toolbar.querySelectorAll("button").forEach((btn) => {
            let on = false;
            if (btn.dataset.cmd) {
              try { on = document.queryCommandState(btn.dataset.cmd); } catch { /* noop */ }
            } else if (btn.dataset.block) {
              on = block === btn.dataset.block.toLowerCase();
            }
            btn.classList.toggle("active", on);
          });
        };
        document.addEventListener("selectionchange", syncActive);
        editor.addEventListener("keyup", syncActive);
        editor.addEventListener("mouseup", syncActive);

        // Keep exactly one always-blank line open at the bottom, in realtime.
        const ensureTrailingLine = () => {
          const last = editor.lastElementChild;
          const blank = last && (last.tagName === "P" || last.tagName === "DIV")
            && last.textContent.trim() === "" && !last.querySelector("img,a");
          if (!blank) editor.insertAdjacentHTML("beforeend", "<p><br></p>");
        };
        editor.addEventListener("input", ensureTrailingLine);
        editor.addEventListener("input", syncActive);
        ensureTrailingLine();
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!mayEdit) return;
        errBox.classList.add("hidden");
        const saveBtn = form.querySelector("#tf-save");
        saveBtn.disabled = true;
        const descHtml = sanitizeDesc(form.querySelector("#tf-desc").innerHTML);
        const payload = {
          title: form.querySelector("#tf-title").value.trim(),
          description: isEmptyDesc(descHtml) ? "" : descHtml,
        };
        if (myRole === "ADMIN" || !isEdit) {
          payload.assigneeId = form.querySelector("#tf-assignee").value || null;
          payload.type = form.querySelector("#tf-type").value;
          payload.priority = form.querySelector("#tf-priority").value;
        }
        try {
          if (isEdit) {
            const newStatus = form.querySelector("#tf-status").value;
            if (newStatus !== task.status) payload.status = newStatus;
            const updated = await api.patch(`/projects/${project.id}/tasks/${task.id}`, payload);
            Object.assign(task, updated);
            toast(`${task.ticketId} updated`, "ok");
          } else {
            payload.status = form.querySelector("#tf-status").value;
            const created = await api.post(`/projects/${project.id}/tasks`, payload);
            tasks.push(created);
            toast(`${created.ticketId} created`, "ok");
          }
          close();
          refreshColumns();
        } catch (err) {
          errBox.textContent = err.message;
          errBox.classList.remove("hidden");
          saveBtn.disabled = false;
        }
      });

      const delBtn = modalEl.querySelector("#tf-delete");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          if (!confirm(`Delete ${task.ticketId}? This cannot be undone.`)) return;
          delBtn.disabled = true;
          try {
            await api.del(`/projects/${project.id}/tasks/${task.id}`);
            removeLocal(task.id);
            close();
            refreshColumns();
            toast(`${task.ticketId} deleted`, "ok");
          } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.remove("hidden");
            delBtn.disabled = false;
          }
        });
      }
    },
  });
}

function allowedTargetList(from) {
  return STATUSES
    .filter((s) => s === from || canTransition(from, s))
    .map((value) => ({ value, label: STATUS_LABELS[value] }));
}

/* ---------- Ticket activity log ---------- */

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function actText(ev) {
  const arrow = `<span class="act-arrow">&rarr;</span>`;
  switch (ev.type) {
    case "CREATED":
      return ev.newStatus ? `created this ticket as ${statusPill(ev.newStatus)}` : "created this ticket";
    case "STATUS_CHANGED":
      return `moved ${statusPill(ev.oldStatus)} ${arrow} ${statusPill(ev.newStatus)}`;
    case "TITLE_CHANGED":
      return `renamed <del class="act-old">${esc(truncate(ev.oldValue, 80))}</del> ${arrow} <b>${esc(truncate(ev.newValue, 80))}</b>`;
    case "DESCRIPTION_CHANGED": {
      let t = "updated the description";
      const prev = truncate(ev.newValue, 120);
      if (prev) t += `<div class="act-quote">${esc(prev)}</div>`;
      return t;
    }
    case "ASSIGNEE_CHANGED":
      return `changed assignee <b>${esc(ev.oldValue || "Unassigned")}</b> ${arrow} <b>${esc(ev.newValue || "Unassigned")}</b>`;
    default:
      return esc(String(ev.type || "").toLowerCase().replaceAll("_", " "));
  }
}

function activityItemHtml(ev) {
  const who = ev.actorName || "Someone";
  return `
  <li class="activity-item">
    ${avatarHtml(who, ev.actorId)}
    <div class="act-body">
      <div class="act-text"><b>${esc(who)}</b> ${actText(ev)}</div>
      <div class="act-when">${fmtDate(ev.createdAt)}</div>
    </div>
  </li>`;
}

function loadActivity(listEl, taskId) {
  api.get(`/projects/${project.id}/tasks/${taskId}/events`)
    .then((events) => {
      // Newest first.
      const desc = [...events].reverse();
      listEl.innerHTML = desc.length
        ? desc.map(activityItemHtml).join("")
        : `<li class="act-empty">No activity yet.</li>`;
    })
    .catch(() => {
      listEl.innerHTML = `<li class="act-empty">Activity could not be loaded.</li>`;
    });
}

/* ---------- Comments (any member can comment on any ticket; @mentions supported) ---------- */

function renderCommentBody(body) {
  // Escape first, then turn @[Name](userId) tokens into mention chips.
  return esc(body)
    .replace(/\[@([^\]]+)\]\(([^)]+)\)/g, (_m, name, id) =>
      `<span class="mention${id === state.user?.id ? " me" : ""}">@${name}</span>`)
    .replaceAll("\n", "<br>");
}

function commentItemHtml(c) {
  const who = c.authorName || "Unknown";
  return `
  <li class="comment-item">
    ${avatarHtml(who, c.authorId)}
    <div class="comment-body">
      <div class="comment-meta"><b>${esc(who)}</b><span class="act-when">${fmtDate(c.createdAt)}</span></div>
      <div class="comment-text">${renderCommentBody(c.body)}</div>
    </div>
  </li>`;
}

function setupComments(modalEl, listEl, taskId) {
  const input = modalEl.querySelector("#tf-comment-input");
  const sendBtn = modalEl.querySelector("#tf-comment-send");
  const menu = modalEl.querySelector("#tf-mention-menu");
  let items = [];

  const hideMenu = () => menu.classList.add("hidden");

  const load = () =>
    api.get(`/projects/${project.id}/tasks/${taskId}/comments`)
      .then((rows) => {
        // Newest first.
        items = [...rows].sort((a, b) => b.createdAt - a.createdAt);
        listEl.innerHTML = items.length
          ? items.map(commentItemHtml).join("")
          : `<li class="act-empty">No comments yet.</li>`;
      })
      .catch(() => { listEl.innerHTML = `<li class="act-empty">Comments could not be loaded.</li>`; });
  load();

  const submit = async () => {
    const body = input.value.trim();
    if (!body) return;
    sendBtn.disabled = true;
    try {
      const created = await api.post(`/projects/${project.id}/tasks/${taskId}/comments`, { body });
      items.unshift(created);
      listEl.innerHTML = items.map(commentItemHtml).join("");
      input.value = "";
      hideMenu();
    } catch (err) {
      toast(err.message || "Comment failed", "err");
    } finally {
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });

  /* @mention autocomplete over project members */
  const members = project.members || [];
  let matches = [];
  let activeIdx = 0;

  const applyMatch = (m) => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos);
    const at = before.lastIndexOf("@");
    if (at === -1) return hideMenu();
    const token = `@[${m.name}](${m.userId})`;
    input.value = before.slice(0, at) + token + " " + input.value.slice(pos);
    const newPos = at + token.length + 1;
    input.focus();
    input.setSelectionRange(newPos, newPos);
    hideMenu();
  };

  const showMenu = () => {
    if (!matches.length) return hideMenu();
    menu.innerHTML = matches.map((m, i) => `
      <button type="button" class="mention-item${i === activeIdx ? " active" : ""}" data-i="${i}">
        ${avatarHtml(m.name, m.userId)} ${esc(m.name)} <span class="mention-email">${esc(m.email)}</span>
      </button>`).join("");
    menu.classList.remove("hidden");
    menu.querySelectorAll(".mention-item").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus in the textarea
        applyMatch(matches[Number(btn.dataset.i)]);
      });
    });
  };

  input.addEventListener("input", () => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) return hideMenu();
    const q = m[2].toLowerCase();
    matches = members.filter((mm) => mm.name.toLowerCase().includes(q)).slice(0, 6);
    activeIdx = 0;
    showMenu();
  });

  input.addEventListener("keydown", (e) => {
    if (menu.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, matches.length - 1); showMenu(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); showMenu(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMatch(matches[activeIdx]); }
    else if (e.key === "Escape") hideMenu();
  });
  input.addEventListener("blur", () => setTimeout(hideMenu, 120));
}
