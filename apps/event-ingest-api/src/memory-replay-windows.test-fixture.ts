import {
  deliverSealedEvaluationCommit,
  parseSealedEvaluationCommitPayload,
} from "./evaluation-commit-delivery";
import type { EvaluationCommitOutbox } from "./evaluation-commit-outbox-contract";
import {
  EVALUATION_USAGE_REPLAY_WINDOW_MS,
  type EvaluationUsageReplayWindow,
} from "./evaluation-usage-replay-window";
import type { Env } from "./types";

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
  private readonly privacyDeleted = new Set<string>();
  private readonly redactedEventIds = new Map<string, Set<string>>();
  private readonly commits = new Map<
    string,
    { eventId: string; payload: unknown; delivered: boolean; ready: boolean; expiresAt: number }
  >();

  identities(): readonly string[] {
    return [...this.commits.keys()];
  }

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
      payload: this.privacyDeleted.has(identity)
        ? { usage: { privacyDeleted: true }, exposureRows: [] }
        : withoutSelectedExposureRows(payload, this.redactedEventIds.get(identity) ?? new Set()),
      delivered: this.privacyDeleted.has(identity),
      ready: this.privacyDeleted.has(identity),
      expiresAt: now + EVALUATION_USAGE_REPLAY_WINDOW_MS,
    };
    this.commits.set(identity, next);
    return next;
  }

  async activate(identity: string) {
    const existing = await this.lookup(identity);
    if (existing === null) throw new Error("commit not found");
    existing.ready = true;
    return existing;
  }

  async acknowledge(identity: string): Promise<void> {
    const existing = this.commits.get(identity);
    if (existing === undefined) throw new Error("commit not found");
    existing.delivered = true;
  }

  async deliver(identity: string) {
    const existing = await this.lookup(identity);
    if (existing === null) throw new Error("commit not found");
    return existing;
  }

  async flush(env: Env): Promise<void> {
    for (const [identity, commit] of this.commits) {
      if (commit.delivered || !commit.ready) continue;
      try {
        await deliverSealedEvaluationCommit(
          env,
          commit.eventId,
          parseSealedEvaluationCommitPayload(commit.payload),
        );
      } catch {
        continue;
      }
      await this.acknowledge(identity);
    }
  }

  async privacyExport(identity: string, eventIds: readonly string[]) {
    const existing = await this.lookup(identity);
    return existing === null ? [] : selectedExposureRows(existing.payload, eventIds);
  }

  async privacyDelete(identity: string, eventIds: readonly string[]): Promise<number> {
    const redacted = this.redactedEventIds.get(identity) ?? new Set<string>();
    for (const eventId of eventIds) redacted.add(eventId);
    this.redactedEventIds.set(identity, redacted);
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

  async privacyDeleteAll(identity: string): Promise<"evaluation-commit-outbox-purged-v1"> {
    this.privacyDeleted.add(identity);
    const existing = await this.lookup(identity);
    if (existing !== null) {
      existing.payload = { usage: { privacyDeleted: true }, exposureRows: [] };
      existing.delivered = true;
      existing.ready = true;
    }
    return "evaluation-commit-outbox-purged-v1";
  }
}

function withoutSelectedExposureRows(payload: unknown, selected: ReadonlySet<string>): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const value = payload as Record<string, unknown>;
  if (!Array.isArray(value.exposureRows)) return payload;
  return {
    ...value,
    exposureRows: value.exposureRows.filter(
      (row) =>
        typeof row !== "object" ||
        row === null ||
        !selected.has(String((row as Record<string, unknown>).event_id)),
    ),
  };
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
