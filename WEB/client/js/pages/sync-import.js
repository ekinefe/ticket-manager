import { api } from "../api.js";
import { esc, openModal, toast } from "../ui.js";
import { t as tl } from "../i18n.js";
import { navigate } from "../main.js";

// "Update from JSON": compare an edited export with the project, preview the
// differences, let the admin pick what to apply, then apply it.
export function openSyncImport(project) {
  let data = null;
  let fileName = "";
  let reqSeq = 0;

  openModal({
    title: tl("sync.title"),
    wide: true,
    body: `
      <p class="sync-intro">${tl("sync.intro")}</p>
      <div class="sync-file">
        <input type="file" id="sy-file" accept=".json,application/json" />
        <span id="sy-fname" class="sync-fname"></span>
      </div>
      <div id="sy-body" class="hidden">
        <div class="sync-opts" id="sy-opts">
          <label><input type="checkbox" data-o="create" checked /> ${tl("sync.o.create")}</label>
          <label><input type="checkbox" data-o="update" checked /> ${tl("sync.o.update")}</label>
          <div class="sync-sub">
            <label><input type="checkbox" data-f="content" checked /> ${tl("sync.f.content")}</label>
            <label><input type="checkbox" data-f="status" checked /> ${tl("sync.f.status")}</label>
            <label><input type="checkbox" data-f="sprint" checked /> ${tl("sync.f.sprint")}</label>
            <label><input type="checkbox" data-f="people" checked /> ${tl("sync.f.people")}</label>
          </div>
          <label class="sync-danger"><input type="checkbox" data-o="remove" /> ${tl("sync.o.remove")}</label>
        </div>
        <div id="sy-preview" class="sync-preview"></div>
      </div>
      <div class="form-error hidden" id="sy-error"></div>
      <div class="modal-actions">
        <span id="sy-status" class="save-state"></span>
        <span class="right">
          <button class="btn ghost" id="sy-cancel" type="button">${tl("common.cancel")}</button>
          <button class="btn" id="sy-apply" type="button" disabled>${tl("sync.apply")}</button>
        </span>
      </div>`,
    onMount(modalEl, close) {
      const $ = (s) => modalEl.querySelector(s);
      const errBox = $("#sy-error");
      const showError = (m) => { errBox.textContent = m; errBox.classList.toggle("hidden", !m); };

      const options = () => ({
        create: $('[data-o="create"]').checked,
        update: $('[data-o="update"]').checked,
        remove: $('[data-o="remove"]').checked,
        fields: Object.fromEntries([...modalEl.querySelectorAll("[data-f]")].map((c) => [c.dataset.f, c.checked && $('[data-o="update"]').checked])),
      });

      let lastPlan = null;
      async function preview() {
        if (!data) return;
        const seq = ++reqSeq;
        showError("");
        $("#sy-status").textContent = tl("sync.checking");
        $("#sy-apply").disabled = true;
        try {
          const res = await api.post(`/projects/${encodeURIComponent(project.id)}/sync`, { data, options: options() });
          if (seq !== reqSeq) return;
          lastPlan = res.plan;
          $("#sy-preview").innerHTML = planHtml(res.plan);
          const nothing = res.plan.creates.length + res.plan.updateCount + res.plan.deleteCount === 0;
          $("#sy-apply").disabled = nothing;
          $("#sy-status").textContent = nothing ? tl("sync.nothing") : "";
        } catch (err) {
          if (seq !== reqSeq) return;
          $("#sy-preview").innerHTML = "";
          $("#sy-status").textContent = "";
          showError(err.message);
        }
      }

      $("#sy-file").addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        fileName = file.name;
        $("#sy-fname").textContent = fileName;
        try {
          data = JSON.parse(await file.text());
        } catch {
          data = null;
          $("#sy-body").classList.add("hidden");
          showError(tl("sync.badJson"));
          return;
        }
        $("#sy-body").classList.remove("hidden");
        await preview();
      });
      $("#sy-opts").addEventListener("change", (e) => {
        // sub-options only make sense while "update" is on
        if (e.target.dataset.o === "update") modalEl.querySelectorAll("[data-f]").forEach((c) => { c.disabled = !e.target.checked; });
        preview();
      });

      $("#sy-cancel").addEventListener("click", close);
      $("#sy-apply").addEventListener("click", async () => {
        const opts = options();
        if (opts.remove && lastPlan?.deleteCount > 0 && !confirm(tl("sync.confirmDelete", { count: lastPlan.deleteCount }))) return;
        const btn = $("#sy-apply");
        btn.disabled = true;
        $("#sy-status").textContent = tl("sync.applying");
        try {
          const res = await api.post(`/projects/${encodeURIComponent(project.id)}/sync`, { data, options: opts, apply: true });
          const r = res.result;
          toast(tl("sync.done", { created: r.created, updated: r.updated, deleted: r.deleted }), "ok");
          close();
          navigate(location.pathname + location.search);
        } catch (err) {
          btn.disabled = false;
          $("#sy-status").textContent = "";
          showError(err.message);
        }
      });
    },
  });
}

const FIELD = (f) => tl(`sync.field.${f}`);

function planHtml(p) {
  const summary = [
    tl("sync.s.new", { n: p.creates.length }),
    tl("sync.s.changed", { n: p.updateCount }),
    tl("sync.s.same", { n: p.unchanged }),
    tl("sync.s.missing", { n: p.missingCount }),
  ];
  const sprintNote = p.sprintsToCreate.length ? `<div class="sync-note">${tl("sync.newSprints", { names: esc(p.sprintsToCreate.join(", ")) })}</div>` : "";
  const section = (title, count, body, open = false) => count ? `<details class="sync-sec"${open ? " open" : ""}><summary>${title} (${count})</summary>${body}</details>` : "";
  return `
    <div class="sync-summary">${summary.map((s) => `<span>${esc(s)}</span>`).join("")}</div>
    ${p.deleteCount ? `<div class="sync-note sync-warn">${tl("sync.willDelete", { n: p.deleteCount })}</div>` : ""}
    ${sprintNote}
    ${section(tl("sync.sec.new"), p.creates.length, `<ul class="sync-list">${p.creates.slice(0, 200).map((c) => `<li>${esc(c.title)} <span class="sync-dim">· ${esc(c.status)}</span></li>`).join("")}</ul>`, true)}
    ${section(tl("sync.sec.changed"), p.updateCount, `<ul class="sync-list">${p.updates.map((u) => `<li><b class="ticket-id">${esc(u.ticketId)}</b> ${esc(u.title)}<div class="sync-changes">${u.changes.map((c) => `<span>${esc(FIELD(c.field))}: <del>${esc(c.from || "—")}</del> → <b>${esc(c.to || "—")}</b></span>`).join("")}</div></li>`).join("")}</ul>`, true)}
    ${section(tl("sync.sec.missing"), p.missingCount, `<ul class="sync-list">${p.missing.map((m) => `<li><b class="ticket-id">${esc(m.ticketId)}</b> ${esc(m.title)}</li>`).join("")}</ul>`)}
    ${section(tl("sync.sec.warnings"), p.warnings.length, `<ul class="sync-list">${p.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`)}`;
}
