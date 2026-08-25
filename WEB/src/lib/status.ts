export const STATUSES = ["TODO", "IN_PROGRESS", "UNDER_REVIEW", "MERGED", "DEPLOYED", "TEST", "DONE"] as const;

export type Status = (typeof STATUSES)[number];

export const STATUS_COLORS: Record<Status, string> = {
  TODO: "#737373",
  IN_PROGRESS: "#286EB4",
  UNDER_REVIEW: "#C88214",
  MERGED: "#783CA0",
  DEPLOYED: "#1E8C5A",
  TEST: "#CD5F23",
  DONE: "#236E37",
};

export const STATUS_LABELS: Record<Status, string> = {
  TODO: "TO DO",
  IN_PROGRESS: "IN PROGRESS",
  UNDER_REVIEW: "UNDER REVIEW",
  MERGED: "MERGED",
  DEPLOYED: "DEPLOYED",
  TEST: "TEST",
  DONE: "DONE",
};

export const INSTANT_NOTIFY_STATUSES: ReadonlySet<Status> = new Set<Status>([
  "UNDER_REVIEW",
  "DEPLOYED",
  "TEST",
]);

function isStatus(v: unknown): v is Status {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

export function assertStatus(v: unknown): asserts v is Status {
  if (!isStatus(v)) throw new Error(`Unknown status: ${String(v)}`);
}

// Free movement between any two statuses so accidental drags can be undone.
export function canTransition(_from: Status, _to: Status): boolean {
  return true;
}

export function statusSlug(s: Status): string {
  return s.toLowerCase().replaceAll("_", "-");
}
