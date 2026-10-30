import { api } from "../../api.js";
import { state } from "../../main.js";
import { STATUSES, STATUS_LABELS, canTransition, esc, avatarHtml, statusPill, openModal, toast, fmtDate, sanitizeDesc, descToEditorHtml, isEmptyDesc, TASK_TYPES, TYPE_LABELS, PRIORITIES, PRIORITY_LABELS, branchName } from "../../ui.js";
import { t as tl, labels } from "../../i18n.js";
import { exportTicketsPdf } from "../../export-pdf.js";

// Task modal (create/edit, comments, activity, GitHub panel, sharing). The board
// page owns the state (project, tasks, role); it hands in read access and the
// few board actions the modal needs through bindTaskModal().
let D = null;
export function bindTaskModal(deps) {
  D = deps;
}

function assigneeOptions(selectedId) {
  return [`<option value="">${tl("bd.unassigned")}</option>`]
    .concat(D.project.members.map((m) =>
      `<option value="${esc(m.userId)}" ${m.userId === selectedId ? "selected" : ""}>${esc(m.name)}</option>`))
    .join("");
}

export function taskModal(task, presetStatus = "TODO", presetSprintId = "") {
  const isEdit = Boolean(task);
  const mayEdit = !isEdit || D.canModifyTask(task);
  const dis = mayEdit ? "" : "disabled";
  const creator = isEdit ? D.memberById(task.createdBy) : null;

  openModal({
    wide: true,
    title: !isEdit
      ? tl("bd.newTicketTitle")
      : `<span class="ticket-path">${esc(D.project.name)} / ${esc(D.project.sprints.find((x) => x.id === task.sprintId)?.sprintId ?? tl("bd.backlog"))} /</span> <span class="ticket-id">${esc(task.ticketId)}</span> ${mayEdit ? tl("bd.editTicket") : tl("bd.ticketDetails")}`,
    body: `
      <div id="task-error" class="form-error hidden"></div>
      <form id="task-form">
        <div class="task-grid">
          <div class="task-left">
            <div class="field">
              <label for="tf-title">${tl("bd.fTitle")}</label>
              <input id="tf-title" type="text" required ${dis} value="${isEdit ? esc(task.title) : ""}" />
            </div>
            <div class="field">
              <label for="tf-desc">${tl("bd.fDescription")}</label>
              ${mayEdit ? `
              <div class="rte-toolbar" id="tf-desc-toolbar">
                <button type="button" data-cmd="bold" title="${tl("bd.bold")}"><b>B</b></button>
                <button type="button" data-cmd="italic" title="${tl("bd.italic")}"><i>I</i></button>
                <button type="button" data-cmd="underline" title="${tl("bd.underline")}"><u>U</u></button>
                <button type="button" data-cmd="strikeThrough" title="${tl("bd.strike")}"><s>S</s></button>
                <span class="rte-sep"></span>
                <button type="button" data-block="h2" title="${tl("bd.heading")}">H2</button>
                <button type="button" data-block="h3" title="${tl("bd.subheading")}">H3</button>
                <button type="button" data-block="p" title="${tl("bd.paragraph")}">&para;</button>
                <span class="rte-sep"></span>
                <button type="button" data-cmd="insertUnorderedList" title="${tl("bd.bullets")}">&bull; &#8801;</button>
                <button type="button" data-cmd="insertOrderedList" title="${tl("bd.numbers")}">1. &#8801;</button>
                <span class="rte-sep"></span>
                <button type="button" id="tf-link" title="${tl("bd.insLink")}">&#128279;</button>
                <button type="button" id="tf-code" title="${tl("bd.codeBlock")}">&lt;/&gt;</button>
                <button type="button" id="tf-image" title="${tl("bd.insImage")}">&#128444;</button>
                <button type="button" id="tf-video" title="${tl("bd.insVideo")}">&#127916;</button>
                <span class="rte-sep"></span>
                <button type="button" data-cmd="removeFormat" title="${tl("bd.clearFmt")}">&#10539;</button>
              </div>` : ""}
              <input type="file" id="tf-media-input" hidden />
              <div id="tf-desc" class="rte" contenteditable="${mayEdit}" aria-label="${tl("bd.fDescription")}">${descToEditorHtml(isEdit ? task.description : "")}</div>
            </div>
            <div class="modal-actions">
              ${isEdit && mayEdit && D.canDeleteTickets() ? `<button type="button" class="btn danger" id="tf-delete">${tl("bd.delete")}</button>` : ""}
              ${isEdit ? `<button type="button" class="btn ghost" id="tf-pdf" title="${tl("pdf.title")}">${tl("pdf.button")}</button>` : ""}
              ${isEdit && D.myRole === "ADMIN" ? `<button type="button" class="btn ghost" id="tf-share-toggle">${tl("bd.share")}</button>` : ""}
              ${!mayEdit ? `<span class="ro-note">${tl("bd.readOnly")}</span>` : ""}
              <span id="tf-savestate" class="save-state"></span>
              <span class="right">
                ${mayEdit ? `<button type="submit" class="btn" id="tf-save">${isEdit ? tl("bd.save") : tl("bd.createTicket")}</button>` : ""}
                <button type="button" class="btn ghost" data-close>${isEdit ? tl("bd.close") : tl("bd.cancel")}</button>
              </span>
            </div>
            ${isEdit && D.myRole === "ADMIN" ? `<div class="share-panel hidden" id="tf-share-panel"></div>` : ""}
            ${isEdit ? `<div class="dev-panel hidden" id="tf-dev"></div>` : ""}
            ${isEdit ? `
            <div class="comments-block">
              <div class="activity-head">${tl("bd.comments")}</div>
              <div class="comment-box">
                <div class="comment-rte-wrap">
                  <div class="rte-toolbar" id="tf-comment-toolbar">
                    <button type="button" data-cmd="bold" title="${tl("bd.bold")}"><b>B</b></button>
                    <button type="button" data-cmd="italic" title="${tl("bd.italic")}"><i>I</i></button>
                    <button type="button" data-cmd="underline" title="${tl("bd.underline")}"><u>U</u></button>
                    <button type="button" data-cmd="strikeThrough" title="${tl("bd.strike")}"><s>S</s></button>
                    <span class="rte-sep"></span>
                    <button type="button" data-block="h2" title="${tl("bd.heading")}">H2</button>
                    <button type="button" data-block="h3" title="${tl("bd.subheading")}">H3</button>
                    <button type="button" data-block="p" title="${tl("bd.paragraph")}">&para;</button>
                    <span class="rte-sep"></span>
                    <button type="button" data-cmd="insertUnorderedList" title="${tl("bd.bullets")}">&bull; &#8801;</button>
                    <button type="button" data-cmd="insertOrderedList" title="${tl("bd.numbers")}">1. &#8801;</button>
                    <span class="rte-sep"></span>
                    <button type="button" id="tf-comment-link" title="${tl("bd.insLink")}">&#128279;</button>
                    <button type="button" id="tf-comment-code" title="${tl("bd.codeBlock")}">&lt;/&gt;</button>
                    <button type="button" id="tf-comment-image" title="${tl("bd.insImage")}">&#128444;</button>
                    <button type="button" id="tf-comment-video" title="${tl("bd.insVideo")}">&#127916;</button>
                    <span class="rte-sep"></span>
                    <button type="button" data-cmd="removeFormat" title="${tl("bd.clearFmt")}">&#10539;</button>
                  </div>
                  <input type="file" id="tf-comment-media-input" hidden />
                  <div id="tf-comment-input" class="rte comment-rte" contenteditable="true" data-placeholder="${tl("bd.commentPh")}"></div>
                </div>
                <button type="button" class="btn sm" id="tf-comment-send">${tl("bd.send")}</button>
                <div id="tf-mention-menu" class="mention-menu hidden"></div>
              </div>
              <ol id="tf-comments" class="comment-list"><li class="act-empty">${tl("bd.loading")}</li></ol>
            </div>` : ""}
          </div>
          <div class="task-right">
            <div class="detail-card">
              <div class="detail-row">
                <span class="k">${tl("bd.dProject")}</span>
                <span class="v">${esc(D.project.name)}&nbsp;<span class="prefix-chip">${esc(D.project.prefix)}</span></span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">${tl("bd.dTicketId")}</span>
                <span class="v"><span class="ticket-id">${esc(task.ticketId)}</span></span>
              </div>` : ""}
              <div class="detail-row">
                <span class="k">${tl("bd.dType")}${isEdit && D.myRole !== "ADMIN" ? ` ${tl("bd.adminOnly")}` : ""}</span>
                <span class="v">
                  <select id="tf-type" ${!isEdit || D.myRole === "ADMIN" ? dis : "disabled"}>
                    ${TASK_TYPES.map((v) => `<option value="${v}" ${v === (isEdit ? task.type : "TASK") ? "selected" : ""}>${TYPE_LABELS[v]}</option>`).join("")}
                  </select>
                </span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">${tl("bd.dBranch")}</span>
                <span class="v"><code class="branch-chip" id="tf-branch" title="${tl("bd.copyBranch")}">${esc(branchName(task))}</code></span>
              </div>` : ""}
              <div class="detail-row">
                <span class="k">${tl("bd.dPriority")}${isEdit && D.myRole !== "ADMIN" ? ` ${tl("bd.adminOnly")}` : ""}</span>
                <span class="v">
                  <select id="tf-priority" ${!isEdit || D.myRole === "ADMIN" ? dis : "disabled"}>
                    ${PRIORITIES.map((v) => `<option value="${v}" ${v === (isEdit ? task.priority : "MEDIUM") ? "selected" : ""}>${PRIORITY_LABELS[v]}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dStatus")}</span>
                <span class="v">
                  <select id="tf-status" ${dis}>
                    ${(isEdit ? allowedTargetList(task.status) : STATUSES.map((s) => ({ value: s }))).map(({ value, label }) =>
                      `<option value="${esc(value)}" ${value === (isEdit ? task.status : presetStatus) ? "selected" : ""}>${esc(label || STATUS_LABELS[value])}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dLabels")}</span>
                <span class="v">
                  <input type="text" id="tf-labels" ${dis} placeholder="${tl("bd.labelsPh")}" maxlength="340" value="${isEdit ? esc((task.labels || []).join(", ")) : ""}" />
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dDue")}</span>
                <span class="v">
                  <input type="date" id="tf-due" ${dis} value="${isEdit && task.dueDate ? esc(task.dueDate) : ""}" />
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dSprint")}</span>
                <span class="v">
                  <select id="tf-sprint" ${dis}>
                    <option value="">${tl("bd.noSprint")}</option>
                    ${D.project.sprints.map((s) => `<option value="${esc(s.id)}" ${(isEdit ? task.sprintId : presetSprintId) === s.id ? "selected" : ""}>${esc(s.sprintId)} &mdash; ${esc(s.name)}</option>`).join("")}
                  </select>
                </span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dAssignee")}${isEdit && mayEdit && D.myRole !== "ADMIN" ? ` ${tl("bd.adminOnly")}` : ""}</span>
                <span class="v">
                  <select id="tf-assignee" ${mayEdit && (D.myRole === "ADMIN" || !isEdit) ? "" : "disabled"}>${assigneeOptions(isEdit ? task.assigneeId : "")}</select>
                </span>
              </div>
              ${isEdit ? `
              <div class="detail-row">
                <span class="k">${tl("bd.dCreatedBy")}</span>
                <span class="v">${creator ? `${avatarHtml(creator.name, creator.userId)} ${esc(creator.name)}` : "&mdash;"}</span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dCreated")}</span>
                <span class="v">${fmtDate(task.createdAt)}</span>
              </div>
              <div class="detail-row">
                <span class="k">${tl("bd.dUpdated")}</span>
                <span class="v">${fmtDate(task.updatedAt)}</span>
              </div>` : ""}
            </div>
            ${isEdit ? `
            <div class="detail-card activity-card">
              <div class="activity-head">${tl("bd.activity")}</div>
              <ol id="tf-activity" class="activity-list"><li class="act-empty">${tl("bd.loading")}</li></ol>
            </div>` : ""}
          </div>
        </div>
      </form>`,
    onMount(modalEl, close) {
      modalEl.querySelector("[data-close]").addEventListener("click", close);
      const errBox = modalEl.querySelector("#task-error");
      const form = modalEl.querySelector("#task-form");

      // ---- Auto-save ----
      // Every field change persists immediately. In create mode the ticket is
      // created automatically once a title exists; before that, edits are
      // remembered in `pendingDraft` and flushed on creation.
      let saveChain = Promise.resolve();
      let created = isEdit;
      let taskRef = task;
      const pendingDraft = {};
      const saveStateEl = modalEl.querySelector("#tf-savestate");
      function setSaveState(s, msg = "") {
        if (!saveStateEl) return;
        saveStateEl.className = `save-state ${s}`;
        saveStateEl.textContent =
          s === "saving" ? tl("bd.saving") :
          s === "saved" ? tl("bd.allSaved") :
          s === "error" ? (msg || tl("bd.saveFailed")) :
          s === "draft" ? tl("bd.startTyping") : "";
      }
      const debounce = (fn, ms) => {
        let t;
        return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
      };
      function commit(patch) {
        saveChain = saveChain.then(() => doCommit(patch)).catch(() => {});
        return saveChain;
      }
      async function doCommit(patch) {
        if (created) {
          setSaveState("saving");
          const updated = await api.patch(`/projects/${D.project.id}/tasks/${taskRef.id}`, patch);
          Object.assign(taskRef, updated);
          setSaveState("saved");
          D.refreshColumns();
        } else {
          Object.assign(pendingDraft, patch);
          if (pendingDraft.title && pendingDraft.title.trim()) {
            setSaveState("saving");
            await flushCreate();
          } else {
            setSaveState("draft");
          }
        }
      }
      async function flushCreate() {
        const payload = {
          title: pendingDraft.title.trim(),
          description: pendingDraft.description ?? "",
          status: pendingDraft.status || presetStatus,
          sprintId: pendingDraft.sprintId ?? (presetSprintId || null),
          type: pendingDraft.type || "TASK",
          priority: pendingDraft.priority || "MEDIUM",
          assigneeId: pendingDraft.assigneeId || null,
          labels: pendingDraft.labels || [],
          dueDate: pendingDraft.dueDate || null,
        };
        const createdTask = await api.post(`/projects/${D.project.id}/tasks`, payload);
        created = true;
        taskRef = createdTask;
        D.tasks.push(createdTask);
        const h = modalEl.querySelector(".modal-head h2");
        if (h) h.innerHTML = `<span class="ticket-id">${esc(createdTask.ticketId)}</span> Edit ticket`;
        setSaveState("saved");
        D.refreshColumns();
        toast(tl("bd.ticketCreated", { id: createdTask.ticketId }), "ok");
      }
      if (!isEdit) setSaveState("draft");

      // Full, explicit save of every field (manual "backup" button).
      async function fullSave() {
        const descHtml = sanitizeDesc(form.querySelector("#tf-desc").innerHTML);
        const payload = {
          title: form.querySelector("#tf-title").value.trim(),
          description: isEmptyDesc(descHtml) ? "" : descHtml,
        };
        if (D.myRole === "ADMIN" || !isEdit) {
          payload.assigneeId = form.querySelector("#tf-assignee").value || null;
          payload.type = form.querySelector("#tf-type").value;
          payload.priority = form.querySelector("#tf-priority").value;
        }
        const sprintVal = form.querySelector("#tf-sprint").value;
        payload.sprintId = sprintVal || null;
        payload.labels = D.parseLabelInput(form.querySelector("#tf-labels").value);
        payload.dueDate = form.querySelector("#tf-due").value || null;
        if (isEdit) payload.status = form.querySelector("#tf-status").value;

        if (created) {
          setSaveState("saving");
          const updated = await api.patch(`/projects/${D.project.id}/tasks/${taskRef.id}`, payload);
          Object.assign(taskRef, updated);
          setSaveState("saved");
          D.refreshColumns();
          toast(tl("bd.ticketSaved", { id: taskRef.ticketId }), "ok");
        } else {
          if (!payload.title) {
            setSaveState("draft");
            form.querySelector("#tf-title").focus();
            return;
          }
          setSaveState("saving");
          const createdTask = await api.post(`/projects/${D.project.id}/tasks`, payload);
          created = true;
          taskRef = createdTask;
          D.tasks.push(createdTask);
          const h = modalEl.querySelector(".modal-head h2");
          if (h) h.innerHTML = `<span class="ticket-id">${esc(createdTask.ticketId)}</span> Edit ticket`;
          setSaveState("saved");
          D.refreshColumns();
          toast(tl("bd.ticketCreated", { id: createdTask.ticketId }), "ok");
        }
      }

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
            .then(() => toast(tl("bd.branchCopied"), "ok"))
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
          toast(tl("bd.uploading", { name: file.name }));
          try {
            const fd = new FormData();
            fd.append("file", file);
            const res = await api.upload(`/projects/${D.project.id}/media`, fd);
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
            toast(tl("bd.added", { name: file.name }), "ok");
          } catch (err) {
            toast(err.message || tl("bd.uploadFailed"), "err");
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

      // Auto-save every field as it changes.
      if (mayEdit) {
        const titleEl = modalEl.querySelector("#tf-title");
        const descEl = modalEl.querySelector("#tf-desc");
        const statusSel = modalEl.querySelector("#tf-status");
        const sprintSel = modalEl.querySelector("#tf-sprint");
        const prioritySel = modalEl.querySelector("#tf-priority");
        const typeSel = modalEl.querySelector("#tf-type");
        const assigneeSel = modalEl.querySelector("#tf-assignee");

        if (statusSel && !statusSel.disabled) statusSel.addEventListener("change", () => commit({ status: statusSel.value }));
        if (sprintSel && !sprintSel.disabled) sprintSel.addEventListener("change", () => commit({ sprintId: sprintSel.value || null }));
        if (prioritySel && !prioritySel.disabled) prioritySel.addEventListener("change", () => commit({ priority: prioritySel.value }));
        if (typeSel && !typeSel.disabled) typeSel.addEventListener("change", () => commit({ type: typeSel.value }));
        const labelsInput = modalEl.querySelector("#tf-labels");
        if (labelsInput && !labelsInput.disabled) labelsInput.addEventListener("change", () => commit({ labels: D.parseLabelInput(labelsInput.value) }));
        const dueInput = modalEl.querySelector("#tf-due");
        if (dueInput && !dueInput.disabled) dueInput.addEventListener("change", () => commit({ dueDate: dueInput.value || null }));
        if (assigneeSel && !assigneeSel.disabled) assigneeSel.addEventListener("change", () => commit({ assigneeId: assigneeSel.value || null }));

        if (titleEl) {
          const saveTitle = debounce(() => {
            const v = titleEl.value.trim();
            if (!v) { if (!created) setSaveState("draft"); return; }
            commit({ title: v });
          }, 500);
          titleEl.addEventListener("input", saveTitle);
        }
        if (descEl) {
          const saveDesc = debounce(() => {
            const html = sanitizeDesc(descEl.innerHTML);
            commit({ description: isEmptyDesc(html) ? "" : html });
          }, 700);
          descEl.addEventListener("input", saveDesc);
        }
      }

      // Explicit save button: also catches Enter in the title field.
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!mayEdit) return;
        const saveBtn = form.querySelector("#tf-save");
        if (saveBtn) saveBtn.disabled = true;
        try {
          await fullSave();
        } catch (err) {
          setSaveState("error", err.message);
          toast(err.message, "err");
        } finally {
          if (saveBtn) saveBtn.disabled = false;
        }
      });

      if (isEdit && D.myRole === "ADMIN") setupSharePanel(modalEl, task);
      if (isEdit) loadDevPanel(modalEl, task);
      modalEl.querySelector("#tf-pdf")?.addEventListener("click", () => exportTicketsPdf([{ projectId: D.project.id, id: task.id }]));
      const delBtn = modalEl.querySelector("#tf-delete");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          if (!confirm(tl("bd.deleteConfirm", { id: task.ticketId }))) return;
          delBtn.disabled = true;
          try {
            await api.del(`/projects/${D.project.id}/tasks/${task.id}`);
            D.removeLocal(task.id);
            close();
            D.refreshColumns();
            toast(tl("bd.ticketDeleted", { id: task.ticketId }), "ok");
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

export function actText(ev) {
  const arrow = `<span class="act-arrow">&rarr;</span>`;
  switch (ev.type) {
    case "CREATED":
      return ev.newStatus ? tl("bd.a.createdAs", { status: statusPill(ev.newStatus, undefined, true) }) : tl("bd.a.created");
    case "STATUS_CHANGED":
      return tl("bd.a.moved", { from: statusPill(ev.oldStatus, undefined, true), to: statusPill(ev.newStatus, undefined, true) }).replace("→", arrow);
    case "TITLE_CHANGED":
      return tl("bd.a.renamed", { from: `<del class="act-old">${esc(truncate(ev.oldValue, 80))}</del>`, to: `<b>${esc(truncate(ev.newValue, 80))}</b>` }).replace("→", arrow);
    case "DESCRIPTION_CHANGED": {
      let t = tl("bd.a.desc");
      const prev = truncate(ev.newValue, 120);
      if (prev) t += `<div class="act-quote">${esc(prev)}</div>`;
      return t;
    }
    case "ASSIGNEE_CHANGED":
      return tl("bd.a.assignee", { from: `<b>${esc(ev.oldValue || tl("bd.unassigned"))}</b>`, to: `<b>${esc(ev.newValue || tl("bd.unassigned"))}</b>` }).replace("→", arrow);
    case "SPRINT_CHANGED":
      return tl("bd.a.sprint", { from: `<b>${esc(ev.oldValue || tl("bd.backlog"))}</b>`, to: `<b>${esc(ev.newValue || tl("bd.backlog"))}</b>` }).replace("→", arrow);
    default:
      return esc(String(ev.type || "").toLowerCase().replaceAll("_", " "));
  }
}

function activityItemHtml(ev) {
  const who = ev.actorName || tl("bd.someone");
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
  api.get(`/projects/${D.project.id}/tasks/${taskId}/events`)
    .then((events) => {
      // Newest first.
      const desc = [...events].reverse();
      listEl.innerHTML = desc.length
        ? desc.map(activityItemHtml).join("")
        : `<li class="act-empty">${tl("bd.noActivity")}</li>`;
    })
    .catch(() => {
      listEl.innerHTML = `<li class="act-empty">${tl("bd.activityFailed")}</li>`;
    });
}

/* ---------- Development (GitHub commits / PRs, optional branch creation) ---------- */

const PR_STATE_LABEL = labels("bd.pr", ["open", "draft", "closed", "merged"]);

async function loadDevPanel(modalEl, task) {
  const panel = modalEl.querySelector("#tf-dev");
  if (!panel) return;
  let info;
  try {
    info = await api.get(`/projects/${D.project.id}/tasks/${task.id}/github`);
  } catch {
    return;
  }
  if (!info.repo) return;
  const render = (inf) => {
    panel.classList.remove("hidden");
    const rows = inf.events.map((e) => `
      <li class="dev-item">
        <span class="dev-kind">${e.kind === "PR" ? "PR #" + esc(e.ref) : esc(e.ref.slice(0, 7))}</span>
        ${e.kind === "PR" && e.state ? `<span class="dev-state dev-${esc(e.state)}">${esc(PR_STATE_LABEL[e.state] || e.state)}</span>` : ""}
        ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>` : esc(e.title)}
        <span class="act-when">${esc(e.author || "")} &middot; ${fmtDate(e.updatedAt)}</span>
      </li>`).join("");
    panel.innerHTML = `
      <div class="dev-head">
        <h3>${tl("bd.development")}</h3>
        <span class="share-note">${esc(inf.repo)}</span>
        <a href="/projects/${encodeURIComponent(D.project.id)}/graph" data-nav class="share-note">${tl("bd.viewGraph")}</a>
        ${inf.branchEnabled ? `<button type="button" class="btn sm ghost" id="dev-branch">Create branch ${esc(inf.branchName)}</button>` : ""}
      </div>
      <ul class="dev-list">${rows || `<li class="act-empty">${tl("bd.noDev", { id: `<b>${esc(task.ticketId)}</b>` })}</li>`}</ul>`;
    panel.querySelector("#dev-branch")?.addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api.post(`/projects/${D.project.id}/tasks/${task.id}/github/branch`, {});
        toast(tl(r.created ? "bd.branchCreated" : "bd.branchExists", { name: r.branch }), "ok");
      } catch (err) {
        toast(err.message || tl("bd.branchFailed"), "err");
      } finally {
        ev.target.disabled = false;
      }
    });
  };
  render(info);
}

/* ---------- Sharing (D.project admins only; single ticket, revocable) ---------- */

function setupSharePanel(modalEl, task) {
  const toggle = modalEl.querySelector("#tf-share-toggle");
  const panel = modalEl.querySelector("#tf-share-panel");
  if (!toggle || !panel) return;
  const base = `/projects/${D.project.id}/tasks/${task.id}/share`;
  let loaded = false;

  const render = (st) => {
    const url = st.token ? `${location.origin}/share/${st.token}` : "";
    panel.innerHTML = `
      <label class="share-row">${tl("bd.sh.who")}
        <select id="share-mode">
          <option value="OFF"${st.mode === "OFF" ? " selected" : ""}>${tl("bd.sh.off")}</option>
          <option value="ACCOUNT"${st.mode === "ACCOUNT" ? " selected" : ""}>${tl("bd.sh.account")}</option>
          <option value="LINK"${st.mode === "LINK" ? " selected" : ""}>${tl("bd.sh.link")}</option>
        </select>
      </label>
      ${url ? `
      <div class="share-row">
        <input type="text" id="share-url" readonly value="${esc(url)}" />
        <button type="button" class="btn sm" id="share-copy">${tl("bd.sh.copy")}</button>
        <button type="button" class="btn sm ghost" id="share-rotate" title="${tl("bd.sh.rotateTitle")}">${tl("bd.sh.rotate")}</button>
      </div>
      <p class="share-note">${tl("bd.sh.note")}</p>` : ""}`;
    panel.querySelector("#share-mode").addEventListener("change", (e) => save({ mode: e.target.value }));
    panel.querySelector("#share-copy")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); toast(tl("bd.linkCopied"), "ok"); }
      catch { panel.querySelector("#share-url").select(); }
    });
    panel.querySelector("#share-rotate")?.addEventListener("click", () => {
      if (confirm(tl("bd.sh.confirmRotate"))) save({ mode: st.mode, regenerate: true });
    });
  };

  const save = async (body) => {
    try {
      const st = await api.put(base, body);
      task.shareMode = st.mode;
      render(st);
      toast(tl(st.mode === "OFF" ? "bd.sh.revoked" : "bd.sh.updated"), "ok");
    } catch (err) {
      toast(err.message || tl("bd.sh.failed"), "err");
    }
  };

  toggle.addEventListener("click", async () => {
    panel.classList.toggle("hidden");
    if (panel.classList.contains("hidden") || loaded) return;
    try {
      render(await api.get(base));
      loaded = true;
    } catch (err) {
      panel.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    }
  });
}

/* ---------- Comments (any member can comment on any ticket; @mentions supported) ---------- */

function renderCommentBody(body) {
  // Sanitize HTML from the contenteditable, then turn @[Name](userId) tokens into mention chips.
  let html = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<\/?(?:iframe|object|embed|form|input|textarea|select|button|meta|link)[^>]*>/gi, "");
  html = html.replace(/\[@([^\]]+)\]\(([^)]+)\)/g, (_m, name, id) =>
    `<span class="mention${id === state.user?.id ? " me" : ""}">@${name}</span>`);
  return html;
}

function commentItemHtml(c) {
  const who = c.authorName || tl("bd.unknown");
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
  const toolbar = modalEl.querySelector("#tf-comment-toolbar");
  const sendBtn = modalEl.querySelector("#tf-comment-send");
  const menu = modalEl.querySelector("#tf-mention-menu");
  let items = [];

  /* Comment RTE toolbar (same as the description editor) */
  document.execCommand("styleWithCSS", false, "false");
  toolbar.addEventListener("mousedown", (e) => e.preventDefault());
  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    input.focus();
    if (btn.dataset.cmd) {
      document.execCommand(btn.dataset.cmd, false, null);
    } else if (btn.dataset.block) {
      document.execCommand("formatBlock", false, btn.dataset.block.toUpperCase());
    }
    syncActive();
  });
  modalEl.querySelector("#tf-comment-link").addEventListener("click", () => {
    const url = prompt("Link URL (https://...)");
    if (!url) return;
    input.focus();
    document.execCommand("createLink", false, url);
    syncActive();
  });
  modalEl.querySelector("#tf-comment-code").addEventListener("click", () => {
    input.focus();
    const sel = window.getSelection();
    const txt = sel && !sel.isCollapsed ? sel.toString() : "";
    document.execCommand("insertHTML", false, `<pre><code>${esc(txt)}</code></pre><p></p>`);
    syncActive();
  });

  /* Media upload: remember caret, pick a file, insert returned /media/ URL. */
  const mediaInput = modalEl.querySelector("#tf-comment-media-input");
  let savedRange = null;
  const openPicker = (accept) => {
    const sel = window.getSelection();
    savedRange = sel && sel.rangeCount && input.contains(sel.anchorNode)
      ? sel.getRangeAt(0).cloneRange() : null;
    mediaInput.accept = accept;
    mediaInput.click();
  };
  modalEl.querySelector("#tf-comment-image").addEventListener("click",
    () => openPicker("image/png,image/jpeg,image/gif,image/webp"));
  modalEl.querySelector("#tf-comment-video").addEventListener("click",
    () => openPicker("video/mp4,video/webm,video/quicktime"));
  mediaInput.addEventListener("change", async () => {
    const file = mediaInput.files?.[0];
    mediaInput.value = "";
    if (!file) return;
    toast(tl("bd.uploading", { name: file.name }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.upload(`/projects/${D.project.id}/media`, fd);
      input.focus();
      if (savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
      const html = res.type.startsWith("image/")
        ? `<img src="${esc(res.url)}" alt="${esc(file.name)}">`
        : `<video src="${esc(res.url)}" controls playsinline></video>`;
      document.execCommand("insertHTML", false, html + "<p><br></p>");
      syncActive();
      toast(tl("bd.added", { name: file.name }), "ok");
    } catch (err) {
      toast(err.message || tl("bd.uploadFailed"), "err");
    }
  });

  /* Highlight toolbar buttons matching the formatting at the caret. */
  const syncActive = () => {
    if (!document.contains(input)) return;
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !input.contains(sel.anchorNode)) return;
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
  input.addEventListener("keyup", syncActive);
  input.addEventListener("mouseup", syncActive);

  /* Placeholder behavior */
  const updatePlaceholder = () => {
    input.classList.toggle("empty", input.textContent.trim() === "");
  };
  input.addEventListener("input", updatePlaceholder);
  updatePlaceholder();

  const hideMenu = () => menu.classList.add("hidden");

  const load = () =>
    api.get(`/projects/${D.project.id}/tasks/${taskId}/comments`)
      .then((rows) => {
        items = [...rows].sort((a, b) => b.createdAt - a.createdAt);
        listEl.innerHTML = items.length
          ? items.map(commentItemHtml).join("")
          : `<li class="act-empty">${tl("bd.noComments")}</li>`;
      })
      .catch(() => { listEl.innerHTML = `<li class="act-empty">${tl("bd.commentsFailed")}</li>`; });
  load();

  const submit = async () => {
    const body = input.innerHTML.trim();
    if (!body || input.textContent.trim() === "") return;
    sendBtn.disabled = true;
    try {
      const created = await api.post(`/projects/${D.project.id}/tasks/${taskId}/comments`, { body });
      items.unshift(created);
      listEl.innerHTML = items.map(commentItemHtml).join("");
      input.innerHTML = "";
      updatePlaceholder();
      hideMenu();
    } catch (err) {
      toast(err.message || tl("bd.commentFailed"), "err");
    } finally {
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });

  /* @mention autocomplete over D.project members */
  const members = D.project.members || [];
  let matches = [];
  let activeIdx = 0;

  const applyMatch = (m) => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return hideMenu();
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    const offset = range.startOffset;
    const text = container.nodeType === 3 ? container.textContent : "";
    const before = text.slice(0, offset);
    const at = before.lastIndexOf("@");
    if (at === -1) return hideMenu();
    const token = `@[${m.name}](${m.userId}) `;
    const after = text.slice(offset);
    if (container.nodeType === 3) {
      container.textContent = before.slice(0, at) + token + after;
      const newPos = at + token.length;
      range.setStart(container, newPos);
      range.setEnd(container, newPos);
      sel.removeAllRanges();
      sel.addRange(range);
    }
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
        e.preventDefault();
        applyMatch(matches[Number(btn.dataset.i)]);
        input.focus();
      });
    });
  };

  input.addEventListener("input", () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !input.contains(sel.anchorNode)) return hideMenu();
    const container = sel.anchorContainer || sel.anchorNode;
    const text = container.nodeType === 3 ? container.textContent : "";
    const pos = container.nodeType === 3 ? sel.anchorOffset : text.length;
    const before = text.slice(0, pos);
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
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMatch(matches[activeIdx]); input.focus(); }
    else if (e.key === "Escape") hideMenu();
  });
  input.addEventListener("blur", () => setTimeout(hideMenu, 120));
}
