import {
  deliverSealedEvaluationCommit,
  parseSealedEvaluationCommitPayload,
} from "./evaluation-commit-delivery";
import type { EvaluationCommit } from "./evaluation-commit-outbox-contract";
import { queueRetryDelaySeconds } from "./queue-retry";
import type { Env } from "./types";

const EVALUATION_COMMIT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface OutboxState {
  readonly eventId: string;
  readonly payload: unknown;
  readonly expiresAt: number;
  readonly deliveredAt?: string;
  readonly privacyDeletedAt?: string;
  readonly deliveryState?: "sealed" | "pending" | "publishing" | "delivered";
  readonly publicationAttempts?: number;
  readonly publicationRetryAt?: number;
}

const STATE_KEY = "evaluation-commit-outbox";
const PRIVACY_DELETED_KEY = "evaluation-commit-privacy-deleted";
const REDACTED_EVENT_IDS_KEY = "evaluation-commit-redacted-event-ids";

/**
 * The durable boundary for one remote Evaluation. It seals the usage row and
 * optional Exposure rows before either Tinybird append is attempted, so a
 * retry replays the same pair instead of creating a new partial outcome.
 */
export class EvaluationCommitOutboxDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env?: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const identity = await requestIdentity(request);
    if (identity === null) return new Response("invalid commit identity", { status: 400 });
    return request.method === "POST"
      ? this.write(path, identity, request)
      : new Response("not found", { status: 404 });
  }

  private write(path: string, identity: string, request: Request): Promise<Response> {
    const handlers: Record<string, () => Promise<Response>> = {
      "/lookup": () => this.lookup(),
      "/commit": () => this.commit(identity, request),
      "/activate": () => this.activate(),
      "/privacy-export": () => this.privacyExport(request),
      "/privacy-delete": () => this.privacyDelete(request),
      "/privacy-delete-all": () => this.privacyDeleteAll(),
    };
    return handlers[path]?.() ?? Promise.resolve(new Response("not found", { status: 404 }));
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (state === undefined) return;
    if (state.expiresAt <= Date.now()) {
      await this.ctx.storage.delete([STATE_KEY, PRIVACY_DELETED_KEY, REDACTED_EVENT_IDS_KEY]);
      return;
    }
    if (isDelivered(state)) {
      await this.ctx.storage.setAlarm(state.expiresAt);
      return;
    }
    if (state.deliveryState === "sealed") {
      await this.ctx.storage.setAlarm(state.expiresAt);
      return;
    }
    if (state.publicationRetryAt !== undefined && state.publicationRetryAt > Date.now()) {
      await this.ctx.storage.setAlarm(state.publicationRetryAt);
      return;
    }
    await this.publish(state);
  }

  private async publish(state: OutboxState): Promise<void> {
    if (!this.env) throw new Error("Evaluation commit delivery environment is unavailable");

    const publishing = {
      ...state,
      deliveryState: "publishing" as const,
      publicationAttempts: (state.publicationAttempts ?? 0) + 1,
    };
    await this.ctx.storage.put(STATE_KEY, publishing);
    try {
      await deliverSealedEvaluationCommit(
        this.env,
        state.eventId,
        parseSealedEvaluationCommitPayload(state.payload),
      );
    } catch (error) {
      await this.retryPublication(publishing, error);
      return;
    }

    const current = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (current === undefined || current.privacyDeletedAt !== undefined) {
      throw new Error("Evaluation commit outbox changed during queue publication");
    }
    await this.ctx.storage.put(STATE_KEY, {
      ...current,
      deliveryState: "delivered",
      deliveredAt: new Date().toISOString(),
    });
    await this.ctx.storage.setAlarm(current.expiresAt);
  }

  private async retryPublication(publishing: OutboxState, error: unknown): Promise<void> {
    const current = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (current === undefined || current.privacyDeletedAt !== undefined) {
      throw new Error("Evaluation commit outbox changed during queue publication");
    }
    const publicationAttempts = publishing.publicationAttempts ?? 1;
    const publicationRetryAt =
      Date.now() + queueRetryDelaySeconds(publicationAttempts, publishing.eventId) * 1_000;
    await this.ctx.storage.put(STATE_KEY, {
      ...current,
      deliveryState: "pending",
      publicationAttempts,
      publicationRetryAt,
    });
    await this.ctx.storage.setAlarm(publicationRetryAt);
    console.error("event-ingest-api Evaluation commit outbox publication failed", {
      errorMessage: error instanceof Error ? error.message : "non-error rejection",
    });
  }

  private schedulePublication(state: OutboxState): Promise<void> {
    return this.ctx.storage.setAlarm(
      Math.max(Date.now(), state.publicationRetryAt ?? Number.NEGATIVE_INFINITY),
    );
  }

  private async lookup(): Promise<Response> {
    const existing = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (existing === undefined || existing.expiresAt <= Date.now()) {
      return new Response("commit not found", { status: 404 });
    }
    if (isPublishable(existing) && !isDelivered(existing)) {
      await this.schedulePublication(existing);
    }
    return Response.json(asResponse(existing));
  }

  private async commit(identity: string, request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (payload === undefined) return new Response("invalid commit payload", { status: 400 });

    const now = Date.now();
    const eventId = `sha256:${await sha256Hex(`${identity}\u001f${now}`)}`;
    const existing = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (existing !== undefined && existing.expiresAt > Date.now()) {
      if (isPublishable(existing) && !isDelivered(existing)) {
        await this.schedulePublication(existing);
      }
      return Response.json(asResponse(existing));
    }

    const privacyDeleted = Boolean(await this.ctx.storage.get(PRIVACY_DELETED_KEY));
    const redactedEventIds = (await this.ctx.storage.get<string[]>(REDACTED_EVENT_IDS_KEY)) ?? [];
    const state: OutboxState = {
      eventId,
      payload: privacyDeleted
        ? { usage: { privacyDeleted: true }, exposureRows: [] }
        : withoutExposureRows(payload, redactedEventIds),
      expiresAt: now + EVALUATION_COMMIT_REPLAY_WINDOW_MS,
      deliveryState: privacyDeleted ? "delivered" : "sealed",
      ...(privacyDeleted ? { privacyDeletedAt: new Date(now).toISOString() } : {}),
    };
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.setAlarm(state.expiresAt);
    return Response.json(asResponse(state));
  }

  private async activate(): Promise<Response> {
    const state = await this.currentState();
    if (state === undefined) return new Response("commit not found", { status: 404 });
    if (isDelivered(state)) {
      await this.ctx.storage.setAlarm(state.expiresAt);
      return Response.json(asResponse(state));
    }
    const ready =
      state.deliveryState === "sealed" ? { ...state, deliveryState: "pending" as const } : state;
    if (ready !== state) await this.ctx.storage.put(STATE_KEY, ready);
    await this.schedulePublication(ready);
    return Response.json(asResponse(ready));
  }

  private async privacyExport(request: Request): Promise<Response> {
    const eventIds = await requestEventIds(request);
    if (eventIds === null) return new Response("invalid Event ids", { status: 400 });
    const state = await this.currentState();
    if (state === undefined) return Response.json({ records: [] });
    return Response.json({ records: matchingExposureRows(state.payload, eventIds) });
  }

  private async privacyDelete(request: Request): Promise<Response> {
    const eventIds = await requestEventIds(request);
    if (eventIds === null) return new Response("invalid Event ids", { status: 400 });
    const state = await this.currentState();
    if (state?.deliveryState === "publishing") {
      return new Response("queue publication is unresolved", { status: 409 });
    }
    const prior = (await this.ctx.storage.get<string[]>(REDACTED_EVENT_IDS_KEY)) ?? [];
    await this.ctx.storage.put(REDACTED_EVENT_IDS_KEY, [...new Set([...prior, ...eventIds])]);
    if (state === undefined) return Response.json({ deletedCount: 0 });
    const deleted = matchingExposureRows(state.payload, eventIds).length;
    if (deleted > 0) {
      await this.ctx.storage.put(STATE_KEY, {
        ...state,
        payload: withoutExposureRows(state.payload, eventIds),
      });
    }
    return Response.json({ deletedCount: deleted });
  }

  private async privacyDeleteAll(): Promise<Response> {
    const state = await this.currentState();
    if (state?.deliveryState === "publishing") {
      return new Response("queue publication is unresolved", { status: 409 });
    }
    await this.ctx.storage.put(PRIVACY_DELETED_KEY, true);
    if (state !== undefined && state.privacyDeletedAt === undefined) {
      await this.ctx.storage.put(STATE_KEY, {
        ...state,
        payload: { usage: { privacyDeleted: true }, exposureRows: [] },
        privacyDeletedAt: new Date().toISOString(),
      });
    }
    return Response.json({ proof: "evaluation-commit-outbox-purged-v1" });
  }

  private async currentState(): Promise<OutboxState | undefined> {
    const state = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    return state !== undefined && state.expiresAt > Date.now() ? state : undefined;
  }
}

function asResponse(state: OutboxState): EvaluationCommit {
  return {
    eventId: state.eventId,
    payload: state.payload,
    delivered: isDelivered(state),
    ready: isPublishable(state),
  };
}

function isPublishable(state: OutboxState): boolean {
  return state.deliveryState !== "sealed";
}

function isDelivered(state: OutboxState): boolean {
  return state.deliveredAt !== undefined || state.privacyDeletedAt !== undefined;
}

async function requestIdentity(request: Request): Promise<string | null> {
  try {
    const body = (await request.clone().json()) as { identity?: unknown };
    return typeof body.identity === "string" && /^[a-f0-9]{64}$/.test(body.identity)
      ? body.identity
      : null;
  } catch {
    return null;
  }
}

async function requestPayload(request: Request): Promise<unknown | undefined> {
  try {
    const body = (await request.json()) as { payload?: unknown };
    return body.payload;
  } catch {
    return undefined;
  }
}

async function requestEventIds(request: Request): Promise<readonly string[] | null> {
  try {
    const body = (await request.json()) as { eventIds?: unknown };
    return Array.isArray(body.eventIds) &&
      body.eventIds.length > 0 &&
      body.eventIds.every((eventId) => typeof eventId === "string" && eventId.length > 0)
      ? body.eventIds
      : null;
  } catch {
    return null;
  }
}

function matchingExposureRows(
  payload: unknown,
  eventIds: readonly string[],
): readonly Record<string, unknown>[] {
  const rows = exposureRows(payload);
  const selected = new Set(eventIds);
  return rows.filter((row) => typeof row.event_id === "string" && selected.has(row.event_id));
}

function withoutExposureRows(payload: unknown, eventIds: readonly string[]): unknown {
  if (!isRecord(payload)) throw new Error("Evaluation commit payload is invalid");
  const selected = new Set(eventIds);
  return {
    ...payload,
    exposureRows: exposureRows(payload).filter(
      (row) => typeof row.event_id !== "string" || !selected.has(row.event_id),
    ),
  };
}

function exposureRows(payload: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload.exposureRows)) {
    throw new Error("Evaluation commit Exposure rows are invalid");
  }
  if (payload.exposureRows.some((row) => !isRecord(row))) {
    throw new Error("Evaluation commit Exposure row is invalid");
  }
  return payload.exposureRows as Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
