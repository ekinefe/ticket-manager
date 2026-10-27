import { api } from "../api.js";
import { esc, openModal, toast } from "../ui.js";
import { t } from "../i18n.js";

// Export several projects into one JSON file (or one project into the usual single export)
// and import any of those files back, picking which projects to create.

const BUNDLE = "projects-bundle";
const today = () => new Date().toISOString().slice(0, 10);

function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const check = (name, label, on = true) =>
  `<label class="pdf-opt"><input type="checkbox" name="${name}" ${on ? "checked" : ""} /> ${label}</label>`;

/* ---------- Export ---------- */

export function openProjectsExport(projects, promptText) {
  openModal({
    title: esc(t("pt.exportTitle")),
    body: `
      <form class="pdf-form" id="pt-export">
        <fieldset class="pdf-field">
          <legend class="pdf-label">${t("pt.projects")}</legend>
          <div class="pdf-opts pt-list">
            <label class="pdf-opt pdf-opt-all"><input type="checkbox" id="pt-all" checked /> ${t("pt.selectAll")}</label>
            ${projects.map((p) => `<label class="pdf-opt"><input type="checkbox" name="p" value="${esc(p.id)}" checked /> <span class="prefix-chip sm">${esc(p.prefix)}</span> ${esc(p.name)}</label>`).join("")}
          </div>
        </fieldset>
        <fieldset class="pdf-field">
          <legend class="pdf-label">${t("pt.include")}</legend>
          <div class="pdf-opts pt-include">
            ${check("ai", t("pt.incAi"))}
            ${check("rules", t("pt.incRules"))}
            ${check("comments", t("pt.incComments"))}
            ${check("github", t("pt.incGithub"))}
          </div>
        </fieldset>
        <p class="pdf-hint">${t("pt.exportHint")}</p>
        <div class="modal-actions"><span class="right">
          <button type="submit" class="btn">${t("pt.export")}</button>
          <button type="button" class="btn ghost" data-cancel>${t("common.cancel")}</button>
        </span></div>
      </form>`,
    onMount(el, close) {
      const form = el.querySelector("form");
      const all = form.querySelector("#pt-all");
      const boxes = [...form.querySelectorAll('input[name="p"]')];
      el.querySelector("[data-cancel]").addEventListener("click", close);
      all.addEventListener("change", () => boxes.forEach((b) => { b.checked = all.checked; }));
      boxes.forEach((b) => b.addEventListener("change", () => { all.checked = boxes.every((x) => x.checked); }));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const ids = boxes.filter((b) => b.checked).map((b) => b.value);
        if (!ids.length) { toast(t("pt.pickOne"), "error"); return; }
        const inc = (n) => form.querySelector(`input[name="${n}"]`).checked;
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = t("pt.exporting");
        try {
          const out = [];
          for (const id of ids) {
            const data = await api.get(`/projects/${encodeURIComponent(id)}/export`);
            if (!inc("rules")) delete data.instructions;
            for (const task of data.tasks) {
              if (!inc("comments")) { delete task.comments; delete task.activity; }
              if (!inc("github")) delete task.github;
            }
            out.push(data);
          }
          let file;
          let name;
          if (out.length === 1) {
            file = out[0];
            name = `${file.project.prefix}-export.json`;
            if (inc("ai")) file.aiPrompt = promptText;
          } else {
            file = { exportType: BUNDLE, exportVersion: out[0].exportVersion, exportedAt: new Date().toISOString(), exportedBy: out[0].exportedBy, projects: out };
            if (inc("ai")) file.aiPrompt = promptText;
            name = `projects-export-${today()}.json`;
          }
          download(name, file);
          toast(t("pt.exported", { count: out.length }), "ok");
          close();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = t("pt.export");
          toast(err.message || t("bd.exportFailed"), "error");
        }
      });
    },
  });
}

/* ---------- Import ---------- */

/** Projects inside a parsed file: a bundle has several, anything else is one project. */
export function projectsInFile(data) {
  const list = data?.exportType === BUNDLE && Array.isArray(data.projects) ? data.projects : [data];
  return list.filter((p) => p && p.project?.name);
}

export function openProjectsImport(data, existing, onDone) {
  const list = projectsInFile(data);
  if (!list.length) { toast(t("pt.nothing"), "error"); return; }
  const taken = new Set(existing.map((p) => p.prefix.toUpperCase()));
  openModal({
    title: esc(t("pt.importTitle")),
    wide: true,
    body: `
      <form class="pdf-form" id="pt-import">
        <p class="pdf-hint" style="margin-top:0">${t("pt.importHint")}</p>
        <table class="data pt-table">
          <thead><tr><th></th><th>${t("pt.colName")}</th><th>${t("pt.colPrefix")}</th><th>${t("pt.colTickets")}</th><th>${t("pt.colSprints")}</th><th></th></tr></thead>
          <tbody>
            ${list.map((p, i) => `<tr data-i="${i}">
              <td><input type="checkbox" class="pt-pick" checked /></td>
              <td>${esc(p.project.name)}</td>
              <td><input type="text" class="pt-prefix" value="${esc(String(p.project.prefix || "").toUpperCase())}" maxlength="5" /></td>
              <td>${(p.tasks ?? []).length}</td>
              <td>${(p.sprints ?? []).length}</td>
              <td class="pt-state"></td>
            </tr>`).join("")}
          </tbody>
        </table>
        <div class="modal-actions"><span class="right">
          <button type="submit" class="btn">${t("pt.import")}</button>
          <button type="button" class="btn ghost" data-cancel>${t("common.cancel")}</button>
        </span></div>
      </form>`,
    onMount(el, close) {
      const form = el.querySelector("form");
      el.querySelector("[data-cancel]").addEventListener("click", () => { close(); });
      const rows = [...form.querySelectorAll("tbody tr")];
      // A prefix must be new: flag the ones that clash with an existing project or each other.
      const validate = () => {
        const seen = new Map();
        for (const r of rows) {
          const pick = r.querySelector(".pt-pick");
          if (pick.disabled) continue; // already imported: keep its "Created" note
          if (!pick.checked) { r.querySelector(".pt-state").textContent = ""; r.dataset.bad = ""; continue; }
          const v = r.querySelector(".pt-prefix").value.trim().toUpperCase();
          const bad = !/^[A-Z0-9]{2,5}$/.test(v) ? t("pt.badPrefix") : taken.has(v) ? t("pt.prefixTaken") : seen.has(v) ? t("pt.prefixDup") : "";
          seen.set(v, true);
          r.querySelector(".pt-state").innerHTML = bad ? `<span class="pt-bad">${esc(bad)}</span>` : "";
          r.dataset.bad = bad ? "1" : "";
        }
        form.querySelector('button[type="submit"]').disabled = rows.some((r) => r.querySelector(".pt-pick").checked && r.dataset.bad) || !rows.some((r) => r.querySelector(".pt-pick").checked);
      };
      form.addEventListener("input", validate);
      form.addEventListener("change", validate);
      validate();
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = t("projects.importing");
        let ok = 0;
        let lastId = "";
        for (const r of rows) {
          if (!r.querySelector(".pt-pick").checked) continue;
          const src = list[Number(r.dataset.i)];
          const payload = { ...src, project: { ...src.project, prefix: r.querySelector(".pt-prefix").value.trim().toUpperCase() } };
          try {
            const res = await api.post("/projects/import", payload);
            ok++;
            lastId = res.projectId;
            r.querySelector(".pt-state").innerHTML = `<span class="pt-ok">${esc(t("pt.done", { tickets: res.tasksCreated }))}</span>`;
            r.querySelector(".pt-pick").checked = false;
            r.querySelector(".pt-pick").disabled = true;
          } catch (err) {
            r.querySelector(".pt-state").innerHTML = `<span class="pt-bad">${esc(err.message || t("projects.importFailed"))}</span>`;
          }
        }
        btn.textContent = t("pt.import");
        if (ok) {
          toast(t("pt.imported", { count: ok }), "ok");
          onDone(ok === 1 && list.length === 1 ? lastId : "");
        }
        validate();
      });
    },
  });
}
