import { ApiError } from "../../shared/http";

const MAX_LABELS = 10;
const MAX_LABEL_LEN = 30;

// Accepts an array of strings; trims, drops blanks and case-insensitive duplicates.
export function normalizeLabels(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ApiError(400, "Labels must be an array of strings");
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") throw new ApiError(400, "Labels must be an array of strings");
    const l = raw.trim();
    if (!l) continue;
    if (l.length > MAX_LABEL_LEN) throw new ApiError(400, `A label can be at most ${MAX_LABEL_LEN} characters`);
    if (!out.some((x) => x.toLowerCase() === l.toLowerCase())) out.push(l);
  }
  if (out.length > MAX_LABELS) throw new ApiError(400, `A ticket can have at most ${MAX_LABELS} labels`);
  return out;
}

// The share token is the secret behind a public link: only the project-admin
// share endpoints may return it, never the generic ticket payloads.
// List endpoints select the raw JSON column; hand the client real arrays.
export function withLabelArrays<T extends { labels: string | null }>(rows: T[]): (Omit<T, "labels"> & { labels: string[] })[] {
  return rows.map((r) => ({ ...r, labels: parseLabels(r.labels) }));
}

export function parseLabels(v: string | null | undefined): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Strips the share secret and turns the stored labels JSON into an array.
export function withoutShareToken<T extends { shareToken?: string | null; labels?: string | null }>(row: T): Omit<T, "shareToken" | "labels"> & { labels: string[] } {
  const { shareToken: _omit, labels, ...rest } = row;
  return { ...rest, labels: parseLabels(labels) };
}
