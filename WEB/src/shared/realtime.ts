/**
 * In-process pub/sub for Server-Sent Events, keyed by project.
 * Single-node by design (matches the rate limiter and scheduler); a
 * multi-node deployment would need a shared bus (Redis, SQLite polling...).
 */

type Client = ReadableStreamDefaultController<Uint8Array>;

const clients = new Map<string, Set<Client>>();
const encoder = new TextEncoder();

export function subscribe(projectId: string, client: Client): void {
  let set = clients.get(projectId);
  if (!set) {
    set = new Set();
    clients.set(projectId, set);
  }
  set.add(client);
}

export function unsubscribe(projectId: string, client: Client): void {
  const set = clients.get(projectId);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) clients.delete(projectId);
}

export function publish(projectId: string, event: Record<string, unknown>): void {
  const set = clients.get(projectId);
  if (!set || set.size === 0) return;
  const payload = encoder.encode(`event: ticket-changed\ndata: ${JSON.stringify(event)}\n\n`);
  for (const client of set) {
    try {
      client.enqueue(payload);
    } catch {
      // closed controller; will be cleaned up by its own cancel handler
      set.delete(client);
    }
  }
}

export function subscriberCount(projectId: string): number {
  return clients.get(projectId)?.size ?? 0;
}
