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
    if (c.kind === "pr") {
      // A PR event is not part of the history: lanes simply continue past it.
      const through = lanes.flatMap((l, i) => (l ? [{ x1: i, y1: 0, x2: i, y2: 1, color: l.color }] : []));
      rows.push({ commit: c, col: -1, color: "", segs: through });
      continue;
    }
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

const PR_COLORS = { opened: "#3fb950", merged: "#a371f7", closed: "#f85149" };
let maxLanesForMarker = 0;

function rowSvg(row, width) {
  const x = (i) => PAD + i * LANE_W;
  const y = (f) => f * ROW_H;
  const paths = row.segs.map((s) => {
    if (s.x1 === s.x2) return `<path d="M${x(s.x1)} ${y(s.y1)} L${x(s.x2)} ${y(s.y2)}" stroke="${s.color}" stroke-width="2" fill="none"/>`;
    const mid = (y(s.y1) + y(s.y2)) / 2;
    return `<path d="M${x(s.x1)} ${y(s.y1)} C${x(s.x1)} ${mid} ${x(s.x2)} ${mid} ${x(s.x2)} ${y(s.y2)}" stroke="${s.color}" stroke-width="2" fill="none"/>`;
  }).join("");
  if (row.commit.kind === "pr") {
    const cx = x(maxLanesForMarker);
    const col = PR_COLORS[row.commit.action];
    return `<svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}" aria-hidden="true">${paths}
      <rect x="${cx - 4}" y="${ROW_H / 2 - 4}" width="8" height="8" transform="rotate(45 ${cx} ${ROW_H / 2})" fill="${col}"/></svg>`;
  }
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

  // Commits and PR events (opened / merged / closed) on one newest-first timeline.
  const items = data.commits.map((c) => ({ ...c, kind: "commit", time: c.date }));
  for (const p of data.pulls || []) {
    items.push({ kind: "pr", action: "opened", pr: p, time: p.createdAt, tickets: p.tickets });
    if (p.endedAt && (p.state === "merged" || p.state === "closed")) {
      items.push({ kind: "pr", action: p.state, pr: p, time: p.endedAt, tickets: p.tickets });
    }
  }
  items.sort((a, b) => b.time - a.time);

  const { rows, maxLanes } = layoutGraph(items);
  maxLanesForMarker = maxLanes; // PR markers sit one lane to the right of the tree
  const width = PAD * 2 + maxLanes * LANE_W;
  const tips = new Map();
  for (const b of data.branches) {
    if (!tips.has(b.sha)) tips.set(b.sha, []);
    tips.get(b.sha).push(b);
  }
  const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const cols = `${width}px 190px 84px 170px minmax(280px, 1fr) 112px 56px`;

  const rowHtml = (r) => {
    const c = r.commit;
    if (c.kind === "pr") {
      const p = c.pr;
      const label = { opened: "Opened", merged: "Merged", closed: "Closed" }[c.action];
      return `
      <div class="git-row git-pr git-pr-${c.action}" style="grid-template-columns:${cols}">
        <div class="git-lanes">${rowSvg(r, width)}</div>
        <div class="git-tags"><span class="git-branch">${esc(p.head)}</span></div>
        <div class="git-sha"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"><span class="git-prchip git-prchip-${c.action}">PR #${p.number}</span></a></div>
        <div class="git-author">${esc(p.author || "")}</div>
        <div class="git-desc"><b class="git-prlabel git-prlabel-${c.action}">${label}</b> <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="${esc(p.title)}">${esc(p.title)}</a>${c.tickets.map((t) => ` <span class="prefix-chip">${esc(t)}</span>`).join("")}</div>
        <div class="git-date">${fmtDay(c.time)}</div>
        <div class="git-time">${fmtTime(c.time)}</div>
      </div>`;
    }
    const chips = (tips.get(c.sha) || []).map((b) => `<span class="git-branch${b.isDefault ? " default" : ""}">${esc(b.name)}</span>`).join("");
    return `
      <div class="git-row" style="grid-template-columns:${cols}">
        <div class="git-lanes">${rowSvg(r, width)}</div>
        <div class="git-tags">${chips}</div>
        <div class="git-sha"><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer"><code>${esc(c.sha.slice(0, 7))}</code></a></div>
        <div class="git-author">${esc(c.author || "")}</div>
        <div class="git-desc"><span title="${esc(c.message)}">${esc(c.message || "(no message)")}</span>${c.tickets.map((t) => ` <span class="prefix-chip">${esc(t)}</span>`).join("")}</div>
        <div class="git-date">${fmtDay(c.time)}</div>
        <div class="git-time">${fmtTime(c.time)}</div>
      </div>`;
  };

  root.innerHTML = `
    <div class="page git-graph-page">
      <p><a href="/projects/${encodeURIComponent(projectId)}" data-nav>&larr; Board</a></p>
      <div class="page-head">
        <h1>Git graph</h1>
        <span class="share-note">${esc(data.repo)} &middot; ${data.commits.length} commits, ${data.branches.length} branch${data.branches.length === 1 ? "" : "es"}, ${(data.pulls || []).length} PRs</span>
      </div>
      ${rows.length === 0 ? `<div class="empty-note">No commits found.</div>` : `
      <div class="git-graph">
        <div class="git-row git-head" style="grid-template-columns:${cols}">
          <div>Graph</div><div>Branch</div><div>Commit</div><div>Author</div><div>Description</div><div>Date</div><div>Time</div>
        </div>
        ${rows.map(rowHtml).join("")}
      </div>
      <p class="share-note">Up to 40 recent commits on each of up to 8 branches (default branch first) and the 30 latest PRs. Hollow dots are merge commits; diamonds are PR events (green opened, purple merged, red closed).</p>`}
    </div>`;
}
