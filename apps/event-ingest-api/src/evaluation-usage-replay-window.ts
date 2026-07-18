export const EVALUATION_USAGE_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EvaluationUsageReplayWindow {
  claim(identity: string): Promise<string>;
}

export interface EvaluationUsageReplayWindowNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

interface ReplayWindowState {
  readonly eventId: string;
  readonly expiresAt: number;
}

const STATE_KEY = "evaluation-usage-replay-window";

/**
 * Serializes first receipt for one hashed caller identity. A UTC bucket cannot
 * represent a replay window: this state expires exactly 24 hours after the
 * first receipt, so a retry across midnight remains the same logical event.
 */
export class EvaluationUsageReplayWindowDurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/claim") {
      return new Response("not found", { status: 404 });
    }

    const identity = await claimIdentity(request);
    if (identity === null) return new Response("invalid replay identity", { status: 400 });

    const now = Date.now();
    const state = await this.ctx.storage.get<ReplayWindowState>(STATE_KEY);
    if (state !== undefined && state.expiresAt > now) {
      return Response.json({ eventId: state.eventId });
    }

    const next = {
      eventId: `sha256:${await sha256Hex(`${identity}\u001f${now}`)}`,
      expiresAt: now + EVALUATION_USAGE_REPLAY_WINDOW_MS,
    };
    await this.ctx.storage.put(STATE_KEY, next);
    await this.ctx.storage.setAlarm(next.expiresAt);
    return Response.json({ eventId: next.eventId });
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<ReplayWindowState>(STATE_KEY);
    if (state !== undefined && state.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(STATE_KEY);
    }
  }
}

function durableEvaluationUsageReplayWindow(
  namespace: EvaluationUsageReplayWindowNamespace,
): EvaluationUsageReplayWindow {
  return {
    async claim(identity) {
      const response = await namespace
        .get(namespace.idFromName(identity))
        .fetch("https://evaluation-usage-replay-window.local/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity }),
        });
      if (!response.ok) {
        throw new Error(`Evaluation usage replay claim failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as { eventId?: unknown };
      if (typeof body.eventId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(body.eventId)) {
        throw new Error("Evaluation usage replay claim returned an invalid event id");
      }
      return body.eventId;
    },
  };
}

export function evaluationUsageReplayWindow(
  binding: EvaluationUsageReplayWindow | EvaluationUsageReplayWindowNamespace | undefined,
): EvaluationUsageReplayWindow | undefined {
  if (binding === undefined) return undefined;
  return "claim" in binding ? binding : durableEvaluationUsageReplayWindow(binding);
}

async function claimIdentity(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { identity?: unknown };
    return typeof body.identity === "string" && /^[a-f0-9]{64}$/.test(body.identity)
      ? body.identity
      : null;
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
