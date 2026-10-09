import { api } from "../api.js";
import { esc, fmtDate } from "../ui.js";

const LANE_W = 14;
const ROW_H = 30;
const PAD = 8;
const COLORS = ["#00f3ff", "#ff5dc8", "#ffd23f", "#7bd88f", "#a78bfa", "#ff8a5c", "#5ca8ff", "#e06c75"];

/**
 * Assigns every commit a lane (column) and the line segments needed to draw it.
 * Commits must be newest-first. Each row gets segments in lane/row-fraction
 * coordinates: y 0 = top of the row, 0.5 = the commit dot, 1 = bottom.
 */
export function layoutGraph(commits) {
  let lanes = []; // lanes[i] = { sha: commit expected next in this lane, color } | null
  let nextColor = 0;
  let maxLanes = 1;
  const freeSlot = (arr, avoid = -1) => {
    const i = arr.findIndex((l, idx) => l === null && idx !== avoid);
    return i === -1 ? arr.length : i;
  };
  const rows = [];

  for (const c of commits) {
    const segs = [];
    let col = lanes.findIndex((l) => l && l.sha === c.sha);
    let color;
    const isTip = col === -1;
    if (isTip) {
      col = freeSlot(lanes);
      color = COLORS[nextColor++ % COLORS.length];
    } else {
      color = lanes[col].color;
    }

    // Top half: lanes converging into this commit, and untouched lanes passing through.
    const next = lanes.slice();
    lanes.forEach((l, i) => {
      if (!l) return;
      if (l.sha === c.sha) {
        segs.push({ x1: i, y1: 0, x2: col, y2: 0.5, color: l.color });
        next[i] = null;
      } else {
        segs.push({ x1: i, y1: 0, x2: i, y2: 1, color: l.color });
      }
    });
    while (next.length <= col) next.push(null);

    // Bottom half: continue to parents.
    c.parents.forEach((p, idx) => {
      const existing = next.findIndex((l) => l && l.sha === p);
      if (existing !== -1) {
        segs.push({ x1: col, y1: 0.5, x2: existing, y2: 1, color: next[existing].color });
        return;
      }
      if (idx === 0) {
        next[col] = { sha: p, color };
        segs.push({ x1: col, y1: 0.5, x2: col, y2: 1, color });
      } else {
        const k = freeSlot(next, col);
        const lc = COLORS[nextColor++ % COLORS.length];
        next[k] = { sha: p, color: lc };
        segs.push({ x1: col, y1: 0.5, x2: k, y2: 1, color: lc });
      }
    });

    while (next.length && next[next.length - 1] === null) next.pop();
    maxLanes = Math.max(maxLanes, lanes.length, next.length, col + 1);
    rows.push({ commit: c, col, color, segs });
    lanes = next;
  }
  return { rows, maxLanes };
}

function rowSvg(row, width) {
  const x = (i) => PAD + i * LANE_W;
  const y = (f) => f * ROW_H;
  const paths = row.segs.map((s) => {
    if (s.x1 === s.x2) return `<path d="M${x(s.x1)} ${y(s.y1)} L${x(s.x2)} ${y(s.y2)}" stroke="${s.color}" stroke-width="2" fill="none"/>`;
    const mid = (y(s.y1) + y(s.y2)) / 2;
    return `<path d="M${x(s.x1)} ${y(s.y1)} C${x(s.x1)} ${mid} ${x(s.x2)} ${mid} ${x(s.x2)} ${y(s.y2)}" stroke="${s.color}" stroke-width="2" fill="none"/>`;
  }).join("");
  const merge = row.commit.parents.length > 1;
  return `<svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}" aria-hidden="true">${paths}
    <circle cx="${x(row.col)}" cy="${ROW_H / 2}" r="${merge ? 5 : 4}" fill="${merge ? "var(--bg, #111)" : row.color}" stroke="${row.color}" stroke-width="2"/></svg>`;
}

export async function renderGitGraph(root, projectId) {
  root.innerHTML = `<div class="page"><div class="spinner"></div></div>`;
  let data;
  try {
    data = await api.get(`/projects/${encodeURIComponent(projectId)}/github/graph`);
  } catch (err) {
    root.innerHTML = `
      <div class="page">
        <p><a href="/projects/${encodeURIComponent(projectId)}" data-nav>&larr; Board</a></p>
        <div class="form-error">${esc(err.message)}</div>
      </div>`;
    return;
  }

  const { rows, maxLanes } = layoutGraph(data.commits);
  const width = PAD * 2 + Math.max(maxLanes - 1, 0) * LANE_W;
  const tips = new Map();
  for (const b of data.branches) {
    if (!tips.has(b.sha)) tips.set(b.sha, []);
    tips.get(b.sha).push(b);
  }

  root.innerHTML = `
    <div class="page git-graph-page">
      <p><a href="/projects/${encodeURIComponent(projectId)}" data-nav>&larr; Board</a></p>
      <div class="page-head">
        <h1>Commit graph</h1>
        <span class="share-note">${esc(data.repo)} &middot; ${data.commits.length} commits, ${data.branches.length} branch${data.branches.length === 1 ? "" : "es"}</span>
      </div>
      ${rows.length === 0 ? `<div class="empty-note">No commits found.</div>` : `
      <div class="git-graph">
        ${rows.map((r) => {
          const c = r.commit;
          const branchChips = (tips.get(c.sha) || []).map((b) => `<span class="git-branch${b.isDefault ? " default" : ""}">${esc(b.name)}</span>`).join("");
          const ticketChips = c.tickets.map((t) => `<span class="prefix-chip">${esc(t)}</span>`).join("");
          return `
          <div class="git-row" style="height:${ROW_H}px">
            <div class="git-lanes" style="width:${width}px">${rowSvg(r, width)}</div>
            <div class="git-info">
              ${branchChips}${ticketChips}
              <a class="git-msg" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" title="${esc(c.message)}">${esc(c.message || "(no message)")}</a>
              <span class="git-meta"><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.author || "")} &middot; ${fmtDate(c.date)}</span>
            </div>
          </div>`;
        }).join("")}
      </div>
      <p class="share-note">Shows up to 40 recent commits on each of up to 8 branches (default branch first). Hollow dots are merge commits.</p>`}
    </div>`;
}
