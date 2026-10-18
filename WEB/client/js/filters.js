import { esc } from "./ui.js";
import { t as tl } from "./i18n.js";

// Multi-select filter row: one drop-down per filter (empty selection = "All"), active
// choices shown as removable chips. State is { key: Set<string> } and lives with the caller.

let outsideBound = false;
function closeOnOutsideClick() {
  if (outsideBound) return;
  outsideBound = true;
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".fmenu.open").forEach((m) => { if (!m.contains(e.target)) m.classList.remove("open"); });
  });
}

export function filterRowHtml(defs, sel) {
  return `
    <div class="filter-row2" id="filter-row2">
      ${defs.map((d) => `
        <div class="fmenu" data-key="${esc(d.key)}">
          <button type="button" class="fmenu-btn" aria-haspopup="true">
            <span class="fmenu-label">${esc(d.label)}</span><span class="fmenu-n"></span><span class="fmenu-caret">&#9662;</span>
          </button>
          <div class="fmenu-pop">
            <label class="fmenu-opt fmenu-all"><input type="checkbox" data-all /> ${tl("flt.all")}</label>
            ${d.options.map((o) => `<label class="fmenu-opt"><input type="checkbox" value="${esc(o.value)}"${sel[d.key]?.has(o.value) ? " checked" : ""} /> ${esc(o.label)}</label>`).join("")}
          </div>
        </div>`).join("")}
      <button type="button" class="btn sm ghost hidden" id="filter-clear">${tl("flt.clear")}</button>
      <div class="filter-chips" id="filter-chips"></div>
    </div>`;
}

/** Wires the row; calls onChange(key) after every change. Returns { refresh() } to redraw counts/chips. */
export function bindFilterRow(root, defs, sel, onChange) {
  closeOnOutsideClick();
  const row = root.querySelector("#filter-row2");
  const labelOf = (d, v) => d.options.find((o) => o.value === v)?.label ?? v;

  const refresh = () => {
    let any = false;
    const chips = [];
    for (const d of defs) {
      const set = sel[d.key];
      const menu = row.querySelector(`.fmenu[data-key="${d.key}"]`);
      menu.classList.toggle("active", set.size > 0);
      menu.querySelector(".fmenu-n").textContent = set.size ? String(set.size) : "";
      menu.querySelector("[data-all]").checked = set.size === 0;
      menu.querySelectorAll("input[value]").forEach((i) => { i.checked = set.has(i.value); });
      for (const v of set) { any = true; chips.push(`<span class="filter-chip" data-key="${esc(d.key)}" data-value="${esc(v)}">${esc(d.label)}: ${esc(labelOf(d, v))}<button type="button" class="chip-x" aria-label="${tl("flt.remove")}">&times;</button></span>`); }
    }
    row.querySelector("#filter-chips").innerHTML = chips.join("");
    row.querySelector("#filter-clear").classList.toggle("hidden", !any);
  };

  row.addEventListener("click", (e) => {
    const btn = e.target.closest(".fmenu-btn");
    if (btn) {
      const menu = btn.closest(".fmenu");
      const open = !menu.classList.contains("open");
      row.querySelectorAll(".fmenu.open").forEach((m) => m.classList.remove("open"));
      menu.classList.toggle("open", open);
      return;
    }
    const x = e.target.closest(".chip-x");
    if (x) {
      const chip = x.closest(".filter-chip");
      sel[chip.dataset.key].delete(chip.dataset.value);
      refresh();
      onChange(chip.dataset.key);
      return;
    }
    if (e.target.closest("#filter-clear")) {
      const keys = defs.filter((d) => sel[d.key].size).map((d) => d.key);
      keys.forEach((k) => sel[k].clear());
      refresh();
      keys.forEach(onChange);
    }
  });
  row.addEventListener("change", (e) => {
    const menu = e.target.closest(".fmenu");
    if (!menu) return;
    const key = menu.dataset.key;
    if (e.target.hasAttribute("data-all")) sel[key].clear();
    else if (e.target.checked) sel[key].add(e.target.value);
    else sel[key].delete(e.target.value);
    refresh();
    onChange(key);
  });
  refresh();
  return { refresh };
}
