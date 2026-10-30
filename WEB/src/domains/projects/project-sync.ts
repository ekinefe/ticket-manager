// Update an existing project from an edited JSON export ("sync import").
// planSync() is pure: it compares the file with the project and returns what
// WOULD change, so the UI can show a preview and the caller applies it.

import { sanitizeDescHtml } from "../../shared/sanitize";
import { STATUSES } from "../tickets/index";

const TYPES = ["TASK", "BUG"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const MAX_LABELS = 10;
const MAX_LABEL_LEN = 30;

export interface SyncOptions {
  create: boolean;
  update: boolean;
  remove: boolean;
  fields: { content: boolean; status: boolean; sprint: boolean; people: boolean };
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  create: true, update: true, remove: false,
  fields: { content: true, status: true, sprint: true, people: true },
};

export interface ExistingTask {
  id: string; ticketId: string; title: string; description: string | null;
  status: string; type: string; priority: string;
  sprintId: string | null; assigneeId: string | null;
  labels: string[]; dueDate: string | null; position: number;
}
export interface SyncSprint { id: string; sprintId: string; name: string }
export interface SyncMember { userId: string; name: string; email: string }

export type SprintTarget = { kind: "backlog" } | { kind: "id"; id: string } | { kind: "new"; name: string };

export interface PlannedChange { field: string; from: string; to: string }

export interface PlannedUpdate {
  id: string; ticketId: string; title: string;
  changes: PlannedChange[];
  patch: {
    title?: string; description?: string | null; type?: string; priority?: string;
    status?: string; position?: number | null; // null => append to the end of the new column
    sprint?: SprintTarget; assigneeId?: string | null; labels?: string[]; dueDate?: string | null;
  };
}

export interface PlannedCreate {
  title: string; description: string | null; status: string; type: string; priority: string;
  sprint: SprintTarget; assigneeId: string | null; labels: string[]; dueDate: string | null;
  sourceTicketId: string | null;
}

export interface SyncPlan {
  creates: PlannedCreate[];
  updates: PlannedUpdate[];
  /** tickets in the project that the file does not mention */
  missing: { id: string; ticketId: string; title: string }[];
  /** what will actually be deleted (empty unless options.remove) */
  deletes: { id: string; ticketId: string; title: string }[];
  sprintsToCreate: string[];
  unchanged: number;
  warnings: string[];
}

type Loose = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const norm = (s: string) => s.trim().toLowerCase();
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

function cleanLabels(v: unknown, who: string, warnings: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) { warnings.push(`${who}: labels must be a list, ignored`); return undefined; }
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const l = raw.trim();
    if (!l) continue;
    if (l.length > MAX_LABEL_LEN) { warnings.push(`${who}: label "${l.slice(0, 12)}…" is too long, skipped`); continue; }
    if (!out.some((x) => x.toLowerCase() === l.toLowerCase())) out.push(l);
  }
  if (out.length > MAX_LABELS) { warnings.push(`${who}: only the first ${MAX_LABELS} labels are kept`); return out.slice(0, MAX_LABELS); }
  return out;
}

export function planSync(input: {
  file: unknown;
  tasks: ExistingTask[];
  sprints: SyncSprint[];
  members: SyncMember[];
  options: SyncOptions;
}): SyncPlan {
  const { tasks, sprints, members, options } = input;
  const warnings: string[] = [];
  const file = (input.file && typeof input.file === "object" ? input.file : {}) as Loose;
  const incoming = Array.isArray(file.tasks) ? (file.tasks as unknown[]) : [];
  const fileSprints = Array.isArray(file.sprints) ? (file.sprints as Loose[]) : [];

  const byTicket = new Map(tasks.map((t) => [norm(t.ticketId), t]));
  const sprintById = new Map(sprints.map((s) => [s.id, s]));
  const sprintByCode = new Map(sprints.map((s) => [norm(s.sprintId), s]));
  const sprintByName = new Map(sprints.map((s) => [norm(s.name), s]));
  const sprintLabel = (id: string | null) => (id ? (sprintById.get(id)?.sprintId ?? id) : "Backlog");
  const memberName = (id: string | null) => (id ? (members.find((m) => m.userId === id)?.name ?? id) : "—");

  const newSprints = new Map<string, string>(); // lower name -> display name

  // Where should this entry's sprint go? undefined => the file says nothing.
  const resolveSprint = (t: Loose, who: string): SprintTarget | undefined => {
    let code = t.sprintId, name = t.sprintName;
    if (code === undefined && name === undefined && typeof t.sprint === "number") {
      const fs = fileSprints[t.sprint];
      if (fs) { code = fs.sprintId; name = fs.name; }
    }
    if (code === undefined && name === undefined) return undefined;
    if ((code === null || code === "") && (name === undefined || name === null || name === "")) return { kind: "backlog" };
    if (name === null && code === undefined) return { kind: "backlog" };
    const c = str(code)?.trim();
    if (c && sprintByCode.has(norm(c))) return { kind: "id", id: sprintByCode.get(norm(c))!.id };
    const n = str(name)?.trim();
    if (n && /^backlog$/i.test(n) && !c) return { kind: "backlog" };
    if (n && sprintByName.has(norm(n))) return { kind: "id", id: sprintByName.get(norm(n))!.id };
    if (n) { newSprints.set(norm(n), n); return { kind: "new", name: n }; }
    warnings.push(`${who}: sprint "${c}" does not exist, left unchanged`);
    return undefined;
  };

  // undefined => untouched, null => unassign, string => user id
  const resolveAssignee = (t: Loose, who: string): string | null | undefined => {
    if (t.assigneeId === undefined && t.assignee === undefined) return undefined;
    if (t.assigneeId === null || (t.assigneeId === undefined && t.assignee === null)) return null;
    const id = str(t.assigneeId);
    if (id && members.some((m) => m.userId === id)) return id;
    const who2 = str(t.assignee)?.trim();
    if (who2) {
      const m = members.find((x) => norm(x.name) === norm(who2) || norm(x.email) === norm(who2));
      if (m) return m.userId;
    }
    warnings.push(`${who}: assignee "${who2 ?? id}" is not a member of this project, left unchanged`);
    return undefined;
  };

  const updates: PlannedUpdate[] = [];
  const creates: PlannedCreate[] = [];
  const seen = new Set<string>();
  let unchanged = 0;

  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Loose;
    const code = str(t.ticketId)?.trim();
    const who = code || str(t.title)?.slice(0, 30) || "(untitled)";
    const existing = code ? byTicket.get(norm(code)) : undefined;

    if (existing) {
      if (seen.has(existing.id)) { warnings.push(`${code} appears twice in the file, the second one is ignored`); continue; }
      seen.add(existing.id);
      if (!options.update) continue;
      const u: PlannedUpdate = { id: existing.id, ticketId: existing.ticketId, title: existing.title, changes: [], patch: {} };
      const change = (field: string, from: string, to: string) => u.changes.push({ field, from, to });

      if (options.fields.content) {
        const title = str(t.title)?.trim();
        if (title && title !== existing.title) { u.patch.title = title; change("title", existing.title, title); }
        if (t.description !== undefined && (typeof t.description === "string" || t.description === null)) {
          const next = sanitizeDescHtml(String(t.description ?? "")) || null;
          if (next !== (existing.description || null)) {
            u.patch.description = next;
            change("description", (existing.description || "").slice(0, 80), (next || "").slice(0, 80));
          }
        }
        const type = str(t.type);
        if (type !== undefined) {
          if (!TYPES.includes(type)) warnings.push(`${who}: invalid type "${type}", ignored`);
          else if (type !== existing.type) { u.patch.type = type; change("type", existing.type, type); }
        }
        const pr = str(t.priority);
        if (pr !== undefined) {
          if (!PRIORITIES.includes(pr)) warnings.push(`${who}: invalid priority "${pr}", ignored`);
          else if (pr !== existing.priority) { u.patch.priority = pr; change("priority", existing.priority, pr); }
        }
      }

      if (options.fields.status) {
        const st = str(t.status);
        let statusChanged = false;
        if (st !== undefined) {
          if (!(STATUSES as readonly string[]).includes(st)) warnings.push(`${who}: invalid status "${st}", ignored`);
          else if (st !== existing.status) { u.patch.status = st; u.patch.position = null; statusChanged = true; change("status", existing.status, st); }
        }
        if (typeof t.position === "number" && Number.isFinite(t.position) && t.position !== existing.position) {
          u.patch.position = t.position;
          if (!statusChanged) change("position", String(existing.position), String(t.position));
        }
      }

      if (options.fields.sprint) {
        const target = resolveSprint(t, who);
        if (target) {
          const currentId = existing.sprintId;
          const same = target.kind === "backlog" ? currentId === null : target.kind === "id" ? currentId === target.id : false;
          if (!same) {
            u.patch.sprint = target;
            change("sprint", sprintLabel(currentId), target.kind === "backlog" ? "Backlog" : target.kind === "id" ? sprintLabel(target.id) : `${target.name} (new)`);
          }
        }
      }

      if (options.fields.people) {
        const a = resolveAssignee(t, who);
        if (a !== undefined && a !== existing.assigneeId) { u.patch.assigneeId = a; change("assignee", memberName(existing.assigneeId), memberName(a)); }
        const labels = cleanLabels(t.labels, who, warnings);
        if (labels !== undefined && labels.join("\u0001") !== existing.labels.join("\u0001")) {
          u.patch.labels = labels; change("labels", existing.labels.join(", "), labels.join(", "));
        }
        if (t.dueDate !== undefined) {
          if (t.dueDate !== null && !isDate(t.dueDate)) warnings.push(`${who}: invalid dueDate, ignored`);
          else if ((t.dueDate ?? null) !== existing.dueDate) { u.patch.dueDate = (t.dueDate as string | null) ?? null; change("dueDate", existing.dueDate ?? "", String(t.dueDate ?? "")); }
        }
      }

      if (u.changes.length > 0) updates.push(u); else unchanged++;
      continue;
    }

    // Not in the project => a new ticket (it gets the next free ID).
    const title = str(t.title)?.trim();
    if (!title) { warnings.push(`${who}: no title, skipped`); continue; }
    if (code) warnings.push(`${code} is not in this project, it will be created as a new ticket with a new ID`);
    if (!options.create) continue;
    const status = str(t.status) && (STATUSES as readonly string[]).includes(str(t.status)!) ? str(t.status)! : "TODO";
    const type = str(t.type) && TYPES.includes(str(t.type)!) ? str(t.type)! : "TASK";
    const priority = str(t.priority) && PRIORITIES.includes(str(t.priority)!) ? str(t.priority)! : "MEDIUM";
    creates.push({
      title, status, type, priority,
      description: typeof t.description === "string" ? sanitizeDescHtml(t.description) || null : null,
      sprint: options.fields.sprint ? (resolveSprint(t, who) ?? { kind: "backlog" }) : { kind: "backlog" },
      assigneeId: resolveAssignee(t, who) ?? null,
      labels: cleanLabels(t.labels, who, warnings) ?? [],
      dueDate: isDate(t.dueDate) ? t.dueDate : null,
      sourceTicketId: code ?? null,
    });
  }

  const missing = tasks.filter((t) => !seen.has(t.id)).map((t) => ({ id: t.id, ticketId: t.ticketId, title: t.title }));
  return {
    creates, updates, missing,
    deletes: options.remove ? missing : [],
    sprintsToCreate: [...newSprints.values()],
    unchanged, warnings,
  };
}

/**
 * Rules block embedded at the top of every JSON export, so one file is enough
 * to brief an AI (or a person) on how to edit it and get it back in with
 * "Update from JSON". Values (sprints, members, prefix) come from the project.
 */
export function buildEditInstructions(p: {
  prefix: string;
  sprints: { sprintId: string; name: string }[];
  members: string[];
}) {
  return {
    purpose:
      "This file is an export of one project from Ticket Manager. You can edit it and the owner will load it back with the board's 'Update from JSON' button to update the SAME project (no need to delete and re-import). Before anything is applied the owner sees a preview of every change and chooses what to apply.",
    how_to_edit: [
      "Edit the entries in \"tasks\". Return the COMPLETE file as valid JSON only (no markdown fences, no commentary).",
      "Tickets are matched by \"ticketId\" (for example \"" + p.prefix + "-12\"). Never change, reuse or invent a ticketId on an existing ticket.",
      "Only fields that are present in a ticket are compared. A field you leave out stays as it is in the project. To clear a value, set it explicitly: \"sprintId\": null (moves to Backlog), \"assignee\": null (unassigns), \"dueDate\": null, \"labels\": [], \"description\": \"\".",
      "Keep the ticket's own language and tone for titles and descriptions unless the owner asks otherwise.",
    ],
    you_can_change_per_ticket: {
      title: "Non-empty text.",
      description: "HTML string. Allowed tags only: b, strong, i, em, u, s, p, div, br, ul, ol, li, h2, h3, code, pre, blockquote, span, a (http/https links only). Leave existing <img>/<video> tags exactly as they are.",
      status: "One of the allowed statuses below. Changing it moves the ticket to that column (at the end of the column).",
      type: "TASK or BUG.",
      priority: "LOW, MEDIUM, HIGH or URGENT.",
      sprintId: "A sprint's code from the list below (for example \"" + (p.sprints[0]?.sprintId ?? p.prefix + "-S1") + "\"), or null for Backlog. You may use \"sprintName\" instead. A sprint name that does not exist yet creates a new sprint.",
      assignee: "The full name of a project member from the list below, or null.",
      labels: "List of up to 10 short strings (max 30 characters each).",
      dueDate: "\"YYYY-MM-DD\" or null.",
      position: "Optional number that sets the order inside a column (lower = higher up). Usually leave it alone.",
    },
    you_can_do: {
      create_a_ticket: "Add a new object to \"tasks\" WITHOUT a ticketId (or with one that does not exist). It needs at least a \"title\"; status, type, priority, sprintId, assignee, labels, dueDate and description are optional. The next free ticketId is assigned automatically.",
      move_a_ticket: "Change its \"status\" (column) and/or \"sprintId\".",
      delete_a_ticket: "Remove its object from \"tasks\". Do this ONLY if the owner explicitly asks. Nothing is deleted unless the owner also ticks 'Delete tickets that are not in the file' in the preview, and deletion is permanent.",
    },
    do_not_change: [
      "\"ticketId\" and \"id\" of existing tickets",
      "\"createdAt\", \"updatedAt\", \"createdBy\", \"branch\"",
      "\"comments\", \"activity\", \"github\" (read-only history; ignored on import — keep them or leave them out, never rewrite them)",
      "the top-level \"project\", \"members\", \"summary\", \"exportedAt\", \"exportedBy\" and this \"instructions\" block (informational; ignored on import)",
      "do not rename the field names, and do not add fields that are not listed here (they are ignored)",
    ],
    allowed_values: {
      status: [...STATUSES],
      type: [...TYPES],
      priority: [...PRIORITIES],
      sprints: p.sprints.map((s) => ({ sprintId: s.sprintId, name: s.name })),
      assignee_members: p.members,
    },
    before_you_answer: [
      "Check that every ticketId you kept still exists exactly once.",
      "Check that every status / type / priority / sprintId / assignee you used is in allowed_values.",
      "Check that the output is valid JSON and contains the complete \"tasks\" list.",
    ],
  };
}
