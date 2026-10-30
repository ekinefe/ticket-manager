import { state } from "../../main.js";
import { esc } from "../../ui.js";
import { t as tl, labels as permLabels } from "../../i18n.js";

/* ---------------- Per-project, per-member granular permissions ---------------- */
// Mirrors PROJECT_PERMISSIONS / DEFAULT_MEMBER_PERMISSIONS in src/domains/access/rbac.ts.
// Project/super admins always have every permission implicitly; these only
// apply to (and are only shown/editable for) plain MEMBER rows.
export const PERMISSION_LABELS = permLabels("perm", [
  "VIEW_ALL_TICKETS", "CREATE_TICKET", "COMMENT_ON_OTHERS_TICKETS", "MOVE_OTHERS_TICKETS",
  "DELETE_TICKET", "MANAGE_MEMBERS", "MANAGE_SPRINTS",
]);
// One-click permission sets. Contributor matches the default for new members.
const PERMISSION_PRESETS = {
  viewer: ["VIEW_ALL_TICKETS"],
  contributor: ["VIEW_ALL_TICKETS", "CREATE_TICKET", "COMMENT_ON_OTHERS_TICKETS"],
  lead: ["VIEW_ALL_TICKETS", "CREATE_TICKET", "COMMENT_ON_OTHERS_TICKETS", "MOVE_OTHERS_TICKETS", "DELETE_TICKET", "MANAGE_MEMBERS", "MANAGE_SPRINTS"],
};
export const DEFAULT_MEMBER_PERMS = ["VIEW_ALL_TICKETS", "CREATE_TICKET", "COMMENT_ON_OTHERS_TICKETS"];

export function permsBlockHtml(scopeId, available, granted) {
  const perms = available && available.length ? available : Object.keys(PERMISSION_LABELS);
  return `
    <div class="up-perms" data-scope="${esc(scopeId)}" style="display:none;grid-template-columns:1fr 1fr;gap:4px 14px;padding:2px 4px 10px 34px">
      <label class="perm-preset-row" style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-weight:400;font-size:12px;color:var(--text-dim);margin:0 0 2px">
        ${tl("acc.preset")}
        <select class="perm-preset" style="max-width:190px">
          <option value="">${tl("acc.presetPick")}</option>
          ${Object.keys(PERMISSION_PRESETS).map((k) => `<option value="${k}">${tl(`acc.preset.${k}`)}</option>`).join("")}
        </select>
      </label>
      ${perms.map((key) => `
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:12px;color:var(--text-dim);margin:0;cursor:pointer">
          <input type="checkbox" class="perm-cb" value="${esc(key)}" ${granted.includes(key) ? "checked" : ""} />
          ${esc(PERMISSION_LABELS[key] || key)}
        </label>`).join("")}
    </div>`;
}

// Keeps a permission block's visibility/enabled-state in sync with its row's
// membership checkbox and role select. `granted` is that member's saved
// permission set (or DEFAULT_MEMBER_PERMS for a not-yet-a-member row) —
// restored whenever the role flips back to MEMBER from ADMIN.
export function wirePermsToggle(row, permsBlock, granted) {
  const cb = row.querySelector("input[type=checkbox]");
  const sel = row.querySelector(".up-role");
  const update = () => {
    const isMember = cb.checked;
    const isAdmin = sel.value === "ADMIN";
    permsBlock.style.display = isMember ? "grid" : "none";
    for (const pcb of permsBlock.querySelectorAll(".perm-cb")) {
      pcb.disabled = isAdmin;
      pcb.checked = isAdmin || granted.includes(pcb.value);
    }
  };
  cb.addEventListener("change", update);
  sel.addEventListener("change", update);
  const preset = permsBlock.querySelector(".perm-preset");
  if (preset) {
    preset.addEventListener("change", () => {
      const set = PERMISSION_PRESETS[preset.value];
      if (!set) return;
      for (const pcb of permsBlock.querySelectorAll(".perm-cb")) if (!pcb.disabled) pcb.checked = set.includes(pcb.value);
      granted = set.slice(); // keep the preset if the role flips back to MEMBER
      preset.value = "";
    });
  }
  update();
}
