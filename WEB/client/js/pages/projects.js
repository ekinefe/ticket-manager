import { api } from "../api.js";
import { loadProjects, state } from "../main.js";
import { esc, roleChip, statusPill, STATUSES, toast, openModal } from "../ui.js";

const PROMPT_TEMPLATE = `You are a project planning assistant. Read the project description below carefully and break it into sprints and actionable tickets.

Output ONLY valid JSON — no markdown, no explanation, no code fences.

EXPECTED OUTPUT FORMAT:

{
  "project": { "name": "Project Name", "prefix": "ABC" },
  "sprints": [
    { "name": "Sprint 1 - Setup & Infrastructure" },
    { "name": "Sprint 2 - Core Features" },
    { "name": "Sprint 3 - Testing & Launch" }
  ],
  "tasks": [
    {
      "title": "Setup CI/CD pipeline",
      "description": "Configure GitHub Actions for automated testing and deployment. Include linting, unit tests, and staging deployment. Acceptance criteria: pipeline runs on every PR, deploys to staging on main merge.",
      "type": "TASK",
      "priority": "HIGH",
      "status": "TODO",
      "sprint": 0
    }
  ]
}

FIELD RULES (fill ALL of them):

project.name — descriptive project name
project.prefix — 2-5 uppercase letters/digits, short abbreviation (e.g. "PLN", "WCE", "AI")

sprints[] — logical phases of the project:
  - Name should describe the phase (e.g. "Foundation", "Core Features", "Polish")
  - Order sprints chronologically (dependencies first)
  - 3-8 sprints depending on project size
  - Each sprint should have 3-10 tasks (not too few, not too many)

tasks[] — every actionable piece of work:
  title — clear, concise, actionable (start with verb: "Implement...", "Setup...", "Fix...", "Write...")
  description — detailed explanation of what to do, why it matters, and acceptance criteria
  type — "TASK" for new work, "BUG" for defect fixes
  priority — based on dependencies and importance:
    "URGENT" = blocks everything else, must be done first
    "HIGH" = critical path, needed for next sprint
    "MEDIUM" = important but not blocking
    "LOW" = nice to have, can wait
  status — always "TODO" for all tickets
  sprint — 0-based index (which sprint this belongs to)

RULES:
1. Fill ALL fields for every ticket. No empty titles or descriptions.
2. Read the ENTIRE project description. Don't skip sections.
3. For long documents (PDF, .tex, .docx), identify all major features/modules and create tickets for each.
4. Group related work into the same sprint.
5. Consider dependencies: infrastructure before features, features before polish.
6. Each ticket should be completable in 1-3 days. Split large tasks.
7. Description should include what to build, why, and how to verify it's done.
8. Don't create redundant tickets. Each ticket = one distinct deliverable.
9. Assignee is always null (assigned later by the team).

PROJECT DESCRIPTION:

[PASTE YOUR PROJECT DESCRIPTION HERE]`;

export async function renderProjects(root) {
  root.innerHTML = `<div class="page"><div class="spinner"></div></div>`;

  let projects;
  try {
    projects = await loadProjects(true);
  } catch (err) {
    if (err.status === 401) { state.user = null; navigate("/login"); return; }
    root.innerHTML = `<div class="page"><div class="form-error">${esc(err.message)}</div></div>`;
    return;
  }

  const isSuper = state.user.role === "SUPER_ADMIN";
  const canImport = isSuper || state.user.role === "ADMIN";

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h1>Projects</h1>
        <span class="spacer" style="flex:1"></span>
        ${canImport ? `<button class="btn sm ghost" id="template-btn">AI Prompt</button>` : ""}
        ${canImport ? `<button class="btn sm ghost" id="import-btn">Import JSON</button>` : ""}
        ${isSuper || state.user.role === "ADMIN" ? `<a class="btn sm" href="/admin/projects" data-nav>+ New project</a>` : ""}
        <input type="file" id="import-file" accept=".json" style="display:none" />
      </div>
      ${projects.length === 0
        ? `<div class="empty-note">No projects yet.${isSuper ? " Create one from the admin panel." : " Ask an admin to invite you."}</div>`
        : `<div class="project-list">
            ${projects.map((p) => projectRow(p, isSuper)).join("")}
          </div>`}
    </div>`;

  if (canImport) {
    document.getElementById("template-btn").addEventListener("click", () => {
      openModal({
        title: "AI Prompt Template",
        wide: true,
        body: `
          <p style="margin:0 0 10px;color:var(--text-dim);font-size:13px">Copy the prompt below, paste your project description where it says <code>[PASTE YOUR PROJECT DESCRIPTION HERE]</code>, and give it to any AI.</p>
          <pre class="template-code" id="template-code">${esc(PROMPT_TEMPLATE)}</pre>
          <div class="modal-actions" style="margin-top:12px">
            <button class="btn sm ghost" id="tpl-copy">Copy to clipboard</button>
            <button class="btn sm" id="tpl-close">Done</button>
          </div>`,
        onMount(modalEl, close) {
          modalEl.querySelector("#tpl-close").addEventListener("click", close);
          modalEl.querySelector("#tpl-copy").addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(PROMPT_TEMPLATE);
              toast("Copied to clipboard");
            } catch {
              toast("Copy failed — select manually", "error");
            }
          });
        },
      });
    });

    const importBtn = document.getElementById("import-btn");
    const fileInput = document.getElementById("import-file");
    importBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        importBtn.disabled = true;
        importBtn.textContent = "Importing...";
        const res = await api.post("/projects/import", data);
        toast(`Imported: ${res.tasksCreated} tickets in ${res.sprintsCreated} sprints`);
        navigate(`/projects/${res.projectId}`);
      } catch (err) {
        toast(err.message || "Import failed", "error");
      } finally {
        importBtn.disabled = false;
        importBtn.textContent = "Import JSON";
        fileInput.value = "";
      }
    });
  }
}

function projectRow(p, isSuper) {
  const myRole = p.role ?? (isSuper ? "ADMIN" : null);
  const counts = p.statusCounts || {};
  const tickets = Number(p.ticketCount ?? 0);
  const breakdown = STATUSES
    .filter((s) => counts[s] > 0)
    .map((s) => statusPill(s, counts[s], true))
    .join("");
  return `
    <a class="project-row" href="/projects/${encodeURIComponent(p.id)}" data-nav>
      <span class="row-top">
        <span class="name">${esc(p.name)}</span>
        <span class="prefix-chip">${esc(p.prefix)}</span>
        <span class="total" title="Total tickets">${tickets} ticket${tickets === 1 ? "" : "s"}</span>
        <span class="meta">
          ${roleChip(myRole)}
          <span class="arrow">Open board &rarr;</span>
        </span>
      </span>
      <span class="row-tags">
        ${breakdown || `<span style="color:var(--text-dim)">No tickets</span>`}
      </span>
    </a>`;
}
