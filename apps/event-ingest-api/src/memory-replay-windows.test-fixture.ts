import type { EvaluationCommitOutbox } from "./evaluation-commit-outbox";
import {
  EVALUATION_USAGE_REPLAY_WINDOW_MS,
  type EvaluationUsageReplayWindow,
} from "./evaluation-usage-replay-window";

export class MemoryReplayWindow implements EvaluationUsageReplayWindow {
  private readonly claims = new Map<string, { eventId: string; expiresAt: number }>();

  async claim(identity: string): Promise<string> {
    const now = Date.now();
    const existing = this.claims.get(identity);
    if (existing !== undefined && existing.expiresAt > now) return existing.eventId;

    const eventId = await eventIdFor(identity, now);
    this.claims.set(identity, { eventId, expiresAt: now + EVALUATION_USAGE_REPLAY_WINDOW_MS });
    return eventId;
  }
}

export class MemoryEvaluationCommitOutbox implements EvaluationCommitOutbox {
  private readonly commits = new Map<
    string,
    { eventId: string; payload: unknown; delivered: boolean; expiresAt: number }
  >();

  async lookup(identity: string) {
    const now = Date.now();
    const existing = this.commits.get(identity);
    if (existing !== undefined && existing.expiresAt > now) return existing;
    return null;
  }

  async commit(identity: string, payload: unknown) {
    const now = Date.now();
    const existing = this.commits.get(identity);
    if (existing !== undefined && existing.expiresAt > now) return existing;

    const next = {
      eventId: await eventIdFor(identity, now),
      payload,
      delivered: false,
      expiresAt: now + EVALUATION_USAGE_REPLAY_WINDOW_MS,
    };
    this.commits.set(identity, next);
    return next;
  }

  async acknowledge(identity: string): Promise<void> {
    const existing = this.commits.get(identity);
    if (existing === undefined) throw new Error("commit not found");
    existing.delivered = true;
  }

  async privacyExport(identity: string, eventIds: readonly string[]) {
    const existing = await this.lookup(identity);
    return existing === null ? [] : selectedExposureRows(existing.payload, eventIds);
  }

  async privacyDelete(identity: string, eventIds: readonly string[]): Promise<number> {
    const existing = await this.lookup(identity);
    if (existing === null) return 0;
    const selected = new Set(eventIds);
    const rows = selectedExposureRows(existing.payload, eventIds);
    const payload = existing.payload as Record<string, unknown>;
    existing.payload = {
      ...payload,
      exposureRows: (payload.exposureRows as Record<string, unknown>[]).filter(
        (row) => typeof row.event_id !== "string" || !selected.has(row.event_id),
      ),
    };
    return rows.length;
  }
}

function selectedExposureRows(
  payload: unknown,
  eventIds: readonly string[],
): readonly Record<string, unknown>[] {
  if (typeof payload !== "object" || payload === null) return [];
  const rows = (payload as { exposureRows?: unknown }).exposureRows;
  if (!Array.isArray(rows)) return [];
  const selected = new Set(eventIds);
  return rows.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as Record<string, unknown>).event_id === "string" &&
      selected.has((row as Record<string, unknown>).event_id as string),
  );
}

async function eventIdFor(identity: string, now: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${identity}\u001f${now}`),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
