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
