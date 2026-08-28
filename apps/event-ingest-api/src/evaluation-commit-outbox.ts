import {
  deliverSealedEvaluationCommit,
  parseSealedEvaluationCommitPayload,
} from "./evaluation-commit-delivery";
import type { Env } from "./types";

const EVALUATION_COMMIT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EvaluationCommitOutbox {
  lookup(identity: string): Promise<EvaluationCommit | null>;
  commit(identity: string, payload: unknown): Promise<EvaluationCommit>;
  deliver(identity: string): Promise<EvaluationCommit>;
  acknowledge(identity: string): Promise<void>;
  privacyExport(
    identity: string,
    eventIds: readonly string[],
  ): Promise<readonly Record<string, unknown>[]>;
  privacyDelete(identity: string, eventIds: readonly string[]): Promise<number>;
  privacyDeleteAll(identity: string): Promise<"evaluation-commit-outbox-purged-v1">;
}

export interface EvaluationCommitOutboxNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

interface EvaluationCommit {
  readonly eventId: string;
  readonly payload: unknown;
  readonly delivered: boolean;
}

interface OutboxState {
  readonly eventId: string;
  readonly payload: unknown;
  readonly expiresAt: number;
  readonly deliveredAt?: string;
  readonly privacyDeletedAt?: string;
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
      ? this.ctx.blockConcurrencyWhile(() => this.write(path, identity, request))
      : new Response("not found", { status: 404 });
  }

  private write(path: string, identity: string, request: Request): Promise<Response> {
    const handlers: Record<string, () => Promise<Response>> = {
      "/lookup": () => this.lookup(),
      "/commit": () => this.commit(identity, request),
      "/deliver": () => this.deliver(),
      "/acknowledge": () => this.acknowledge(identity),
      "/privacy-export": () => this.privacyExport(request),
      "/privacy-delete": () => this.privacyDelete(request),
      "/privacy-delete-all": () => this.privacyDeleteAll(),
    };
    return handlers[path]?.() ?? Promise.resolve(new Response("not found", { status: 404 }));
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<OutboxState>(STATE_KEY);
      if (state !== undefined && state.expiresAt <= Date.now()) {
        await this.ctx.storage.delete([STATE_KEY, PRIVACY_DELETED_KEY, REDACTED_EVENT_IDS_KEY]);
      }
    });
  }

  private async lookup(): Promise<Response> {
    const existing = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (existing === undefined || existing.expiresAt <= Date.now()) {
      return new Response("commit not found", { status: 404 });
    }
    return Response.json(asResponse(existing));
  }

  private async commit(identity: string, request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (payload === undefined) return new Response("invalid commit payload", { status: 400 });

    const existing = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (existing !== undefined && existing.expiresAt > Date.now()) {
      return Response.json(asResponse(existing));
    }

    const now = Date.now();
    const privacyDeleted = Boolean(await this.ctx.storage.get(PRIVACY_DELETED_KEY));
    const redactedEventIds = (await this.ctx.storage.get<string[]>(REDACTED_EVENT_IDS_KEY)) ?? [];
    const state: OutboxState = {
      eventId: `sha256:${await sha256Hex(`${identity}\u001f${now}`)}`,
      payload: privacyDeleted
        ? { usage: { privacyDeleted: true }, exposureRows: [] }
        : withoutExposureRows(payload, redactedEventIds),
      expiresAt: now + EVALUATION_COMMIT_REPLAY_WINDOW_MS,
      ...(privacyDeleted ? { privacyDeletedAt: new Date(now).toISOString() } : {}),
    };
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.setAlarm(state.expiresAt);
    return Response.json(asResponse(state));
  }

  private async deliver(): Promise<Response> {
    const state = await this.currentState();
    if (state === undefined) return new Response("commit not found", { status: 404 });
    if (state.deliveredAt !== undefined || state.privacyDeletedAt !== undefined) {
      return Response.json(asResponse(state));
    }
    if (!this.env) throw new Error("Evaluation commit delivery environment is unavailable");
    await deliverSealedEvaluationCommit(
      this.env,
      state.eventId,
      parseSealedEvaluationCommitPayload(state.payload),
    );
    const delivered = { ...state, deliveredAt: new Date().toISOString() };
    await this.ctx.storage.put(STATE_KEY, delivered);
    return Response.json(asResponse(delivered));
  }

  private async acknowledge(identity: string): Promise<Response> {
    const state = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (state === undefined || state.expiresAt <= Date.now()) {
      return new Response("commit not found", { status: 404 });
    }
    if (state.deliveredAt === undefined) {
      await this.ctx.storage.put(STATE_KEY, { ...state, deliveredAt: new Date().toISOString() });
    }
    return Response.json({ ok: true, identity });
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
    await this.ctx.storage.put(PRIVACY_DELETED_KEY, true);
    const state = await this.currentState();
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
    delivered: state.deliveredAt !== undefined || state.privacyDeletedAt !== undefined,
  };
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
