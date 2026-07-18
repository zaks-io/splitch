const EVALUATION_COMMIT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EvaluationCommitOutbox {
  commit(identity: string, payload: unknown): Promise<EvaluationCommit>;
  acknowledge(identity: string): Promise<void>;
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
}

const STATE_KEY = "evaluation-commit-outbox";

/**
 * The durable boundary for one remote Evaluation. It seals the usage row and
 * optional Exposure rows before either Tinybird append is attempted, so a
 * retry replays the same pair instead of creating a new partial outcome.
 */
export class EvaluationCommitOutboxDurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const identity = await requestIdentity(request);
    if (identity === null) return new Response("invalid commit identity", { status: 400 });

    if (request.method === "POST" && path === "/commit") {
      return this.commit(identity, request);
    }
    if (request.method === "POST" && path === "/acknowledge") {
      return this.acknowledge(identity);
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (state !== undefined && state.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(STATE_KEY);
    }
  }

  private async commit(identity: string, request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (payload === undefined) return new Response("invalid commit payload", { status: 400 });

    const existing = await this.ctx.storage.get<OutboxState>(STATE_KEY);
    if (existing !== undefined && existing.expiresAt > Date.now()) {
      return Response.json(asResponse(existing));
    }

    const now = Date.now();
    const state: OutboxState = {
      eventId: `sha256:${await sha256Hex(`${identity}\u001f${now}`)}`,
      payload,
      expiresAt: now + EVALUATION_COMMIT_REPLAY_WINDOW_MS,
    };
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.setAlarm(state.expiresAt);
    return Response.json(asResponse(state));
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
}

function asResponse(state: OutboxState): EvaluationCommit {
  return {
    eventId: state.eventId,
    payload: state.payload,
    delivered: state.deliveredAt !== undefined,
  };
}

function durableEvaluationCommitOutbox(
  namespace: EvaluationCommitOutboxNamespace,
): EvaluationCommitOutbox {
  return {
    async commit(identity, payload) {
      const response = await namespace
        .get(namespace.idFromName(identity))
        .fetch("https://evaluation-commit-outbox.local/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity, payload }),
        });
      if (!response.ok)
        throw new Error(`Evaluation commit outbox returned HTTP ${response.status}`);
      const body = (await response.json()) as Partial<EvaluationCommit>;
      if (
        typeof body.eventId !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(body.eventId) ||
        body.payload === undefined ||
        typeof body.delivered !== "boolean"
      ) {
        throw new Error("Evaluation commit outbox returned an invalid commit");
      }
      return body as EvaluationCommit;
    },
    async acknowledge(identity) {
      const response = await namespace
        .get(namespace.idFromName(identity))
        .fetch("https://evaluation-commit-outbox.local/acknowledge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity }),
        });
      if (!response.ok)
        throw new Error(`Evaluation commit acknowledgement returned HTTP ${response.status}`);
    },
  };
}

export function evaluationCommitOutbox(
  binding: EvaluationCommitOutbox | EvaluationCommitOutboxNamespace | undefined,
): EvaluationCommitOutbox | undefined {
  if (binding === undefined) return undefined;
  return "commit" in binding ? binding : durableEvaluationCommitOutbox(binding);
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
