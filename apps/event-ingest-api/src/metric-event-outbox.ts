import {
  type BeginOutcome,
  beginDelivery,
  isUnresolved,
  type MetricEventDeliveryAttempt,
} from "./metric-event-delivery-attempt";
import type { Env } from "./types";

export interface MetricEventClaim {
  readonly outcome: "accepted" | "duplicate" | "conflict";
  readonly eventDefinitionId: string;
  readonly eventDefinitionVersionId: string;
}

export interface MetricEventLookup {
  readonly fingerprint: string;
  readonly eventDefinitionId: string;
  readonly eventDefinitionVersionId: string;
}

export interface MetricEventOutboxNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

interface ClaimState {
  readonly fingerprint: string;
  readonly eventDefinitionId: string;
  readonly eventDefinitionVersionId: string;
  readonly row?: Record<string, unknown>;
  queued: boolean;
  deleted: boolean;
  publishing?: boolean;
  delivery?: MetricEventDeliveryAttempt;
  readonly expiresAt?: number;
}

const STATE_KEY = "metric-event-claim";
const QUEUE_RETRY_DELAY_MS = 1_000;
/** Matches the default Metric Event replay and analysis retention window. */
export const METRIC_EVENT_CLAIM_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export class MetricEventOutboxDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    return this.handle(request);
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (state === undefined) return;
    const expiresAt = claimExpiresAt(state);
    if (state.expiresAt === undefined) {
      await this.ctx.storage.put(STATE_KEY, { ...state, expiresAt });
    }
    if (expiresAt <= Date.now()) {
      await this.ctx.storage.delete(STATE_KEY);
      return;
    }
    if (state.queued || state.deleted) {
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }
    await this.publish(state, expiresAt);
  }

  private async publish(state: ClaimState, expiresAt: number): Promise<void> {
    if (state.row === undefined) throw new Error("Metric Event outbox row is unavailable");
    if (!this.env.METRIC_EVENTS_QUEUE) {
      throw new Error("METRIC_EVENTS_QUEUE binding is unavailable");
    }

    await this.ctx.storage.put(STATE_KEY, { ...state, expiresAt, publishing: true });
    try {
      await this.env.METRIC_EVENTS_QUEUE.send(state.row);
    } catch (error) {
      await this.ctx.storage.put(STATE_KEY, { ...state, expiresAt, publishing: false });
      await this.ctx.storage.setAlarm(Date.now() + QUEUE_RETRY_DELAY_MS);
      console.error("event-ingest-api Metric Event outbox publication failed", {
        errorMessage: error instanceof Error ? error.message : "non-error rejection",
      });
      return;
    }

    const current = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (current === undefined || current.deleted) {
      throw new Error("Metric Event outbox changed during queue publication");
    }
    await this.ctx.storage.put(STATE_KEY, {
      ...current,
      expiresAt,
      queued: true,
      publishing: false,
    });
    await this.ctx.storage.setAlarm(expiresAt);
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") return this.read(path);
    if (request.method === "POST") return this.write(path, request);
    return new Response("not found", { status: 404 });
  }

  private async read(path: string): Promise<Response> {
    if (path !== "/lookup" && path !== "/export" && path !== "/delivery") {
      return new Response("not found", { status: 404 });
    }
    const stored = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    const existing = stored === undefined ? undefined : await this.retain(stored);
    if (existing === undefined) return new Response("not found", { status: 404 });
    await this.schedulePublication(existing);
    if (path === "/lookup") return Response.json(asLookup(existing));
    if (path === "/delivery") {
      return existing.delivery === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(existing.delivery);
    }
    return Response.json({ deleted: existing.deleted, row: existing.row ?? null });
  }

  private async write(path: string, request: Request): Promise<Response> {
    if (path === "/suppress") return this.suppress(request);
    if (path === "/begin-delivery") return this.beginDelivery(request);
    if (path === "/settle-delivery") return this.settleDelivery(request);
    if (path !== "/claim") return new Response("not found", { status: 404 });
    const incoming = (await request.json()) as ClaimState;
    const stored = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    const existing = stored === undefined ? undefined : await this.retain(stored);
    if (existing !== undefined) {
      if (existing.fingerprint !== incoming.fingerprint) {
        return Response.json(asClaim("conflict", existing));
      }
      await this.schedulePublication(existing);
      return Response.json(asClaim("duplicate", existing));
    }

    const accepted = {
      ...incoming,
      expiresAt: Date.now() + METRIC_EVENT_CLAIM_RETENTION_MS,
    };
    await this.ctx.storage.put(STATE_KEY, accepted);
    await this.schedulePublication(accepted);
    return Response.json(asClaim("accepted", accepted));
  }

  private async schedulePublication(state: ClaimState): Promise<void> {
    if (state.queued || state.deleted) {
      await this.ctx.storage.setAlarm(claimExpiresAt(state));
      return;
    }
    if (state.row === undefined) throw new Error("Metric Event outbox row is unavailable");
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async retain(state: ClaimState): Promise<ClaimState> {
    if (state.expiresAt !== undefined) return state;
    const retained = { ...state, expiresAt: claimExpiresAt(state) };
    await this.ctx.storage.put(STATE_KEY, retained);
    await this.ctx.storage.setAlarm(
      state.queued || state.deleted ? retained.expiresAt : Date.now(),
    );
    return retained;
  }

  /**
   * The write-ahead step. Nothing may reach Tinybird for this row until this
   * record says so, so the decision and the durable write happen here, inside
   * the object that a privacy deletion also mutates.
   */
  private async beginDelivery(request: Request): Promise<Response> {
    const { attemptId } = (await request.json()) as { attemptId?: unknown };
    if (typeof attemptId !== "string" || attemptId.length === 0) {
      return new Response("invalid delivery attempt id", { status: 400 });
    }
    const existing = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (existing === undefined) {
      throw new Error("Metric Event outbox has no record for a queued delivery");
    }
    if (existing.deleted) return Response.json({ kind: "deleted" } satisfies BeginOutcome);
    const { outcome, next } = beginDelivery(existing.delivery, attemptId);
    if (next) await this.ctx.storage.put(STATE_KEY, { ...existing, delivery: next });
    if (outcome) return Response.json(outcome);
    if (existing.row === undefined) {
      throw new Error("Metric Event outbox row is unavailable");
    }
    if (next === undefined) {
      throw new Error("Metric Event outbox claimed a delivery without recording an attempt");
    }
    // The attempt travels with the row so the caller settles the count this
    // record just wrote, instead of reporting a first attempt on every retry.
    return Response.json({
      kind: "claimed",
      row: existing.row,
      attempt: next,
    } satisfies BeginOutcome);
  }

  private async settleDelivery(request: Request): Promise<Response> {
    const attempt = (await request.json()) as MetricEventDeliveryAttempt;
    const existing = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (existing === undefined) {
      throw new Error("Metric Event outbox has no record for a settled delivery");
    }
    if (existing.delivery?.attemptId !== attempt.attemptId) {
      // A later attempt already owns the record; settling here would overwrite
      // its state with a stale outcome.
      return new Response("delivery attempt is no longer current", { status: 409 });
    }
    await this.ctx.storage.put(STATE_KEY, { ...existing, delivery: attempt });
    return Response.json({ settled: attempt.state });
  }

  private async suppress(request: Request): Promise<Response> {
    const input = (await request.json()) as Partial<ClaimState>;
    if (
      typeof input.fingerprint !== "string" ||
      typeof input.eventDefinitionId !== "string" ||
      typeof input.eventDefinitionVersionId !== "string"
    ) {
      return new Response("invalid suppression claim", { status: 400 });
    }
    const existing = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (existing !== undefined && existing.fingerprint !== input.fingerprint) {
      return new Response("suppression claim conflicts with existing event", { status: 409 });
    }
    if (existing?.publishing) {
      return new Response("queue publication is unresolved", { status: 409 });
    }
    if (isUnresolved(existing?.delivery)) {
      // Redacting now would return a deletion proof while this row is still on
      // its way to Tinybird, or while reconciliation still needs the payload.
      // The caller retries; an attempt settles within one Tinybird round trip.
      return new Response(
        `delivery attempt ${String(existing?.delivery?.state)} for this event is unresolved`,
        { status: 409 },
      );
    }
    const expiresAt = existing?.expiresAt ?? Date.now() + METRIC_EVENT_CLAIM_RETENTION_MS;
    await this.ctx.storage.put(STATE_KEY, {
      fingerprint: input.fingerprint,
      eventDefinitionId: existing?.eventDefinitionId ?? input.eventDefinitionId,
      eventDefinitionVersionId:
        existing?.eventDefinitionVersionId ?? input.eventDefinitionVersionId,
      queued: false,
      deleted: true,
      expiresAt,
    });
    await this.ctx.storage.setAlarm(expiresAt);
    return Response.json({ deleted: true, proof: "metric-event-outbox-redacted-v1" });
  }
}

function claimExpiresAt(state: ClaimState): number {
  return state.expiresAt ?? Date.now() + METRIC_EVENT_CLAIM_RETENTION_MS;
}

function asClaim(outcome: MetricEventClaim["outcome"], state: ClaimState): MetricEventClaim {
  return {
    outcome,
    eventDefinitionId: state.eventDefinitionId,
    eventDefinitionVersionId: state.eventDefinitionVersionId,
  };
}

function asLookup(state: ClaimState): MetricEventLookup {
  return {
    fingerprint: state.fingerprint,
    eventDefinitionId: state.eventDefinitionId,
    eventDefinitionVersionId: state.eventDefinitionVersionId,
  };
}

export async function lookupMetricEvent(
  namespace: MetricEventOutboxNamespace | undefined,
  dedupKey: string,
): Promise<MetricEventLookup | null> {
  if (!namespace) throw new Error("METRIC_EVENT_OUTBOX binding is unavailable");
  const response = await namespace
    .get(namespace.idFromName(dedupKey))
    .fetch("https://metric-event-outbox.local/lookup", { method: "GET" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Metric Event outbox lookup returned HTTP ${response.status}`);
  const lookup = (await response.json()) as Partial<MetricEventLookup>;
  if (
    typeof lookup.fingerprint !== "string" ||
    typeof lookup.eventDefinitionId !== "string" ||
    typeof lookup.eventDefinitionVersionId !== "string"
  ) {
    throw new Error("Metric Event outbox returned an invalid lookup");
  }
  return {
    fingerprint: lookup.fingerprint,
    eventDefinitionId: lookup.eventDefinitionId,
    eventDefinitionVersionId: lookup.eventDefinitionVersionId,
  };
}

export async function claimMetricEvent(
  namespace: MetricEventOutboxNamespace | undefined,
  dedupKey: string,
  state: Omit<ClaimState, "queued" | "deleted">,
): Promise<MetricEventClaim> {
  if (!namespace) throw new Error("METRIC_EVENT_OUTBOX binding is unavailable");
  const response = await namespace
    .get(namespace.idFromName(dedupKey))
    .fetch("https://metric-event-outbox.local/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...state, queued: false, deleted: false }),
    });
  if (!response.ok) throw new Error(`Metric Event outbox returned HTTP ${response.status}`);
  const claim = (await response.json()) as MetricEventClaim;
  if (!["accepted", "duplicate", "conflict"].includes(claim.outcome)) {
    throw new Error("Metric Event outbox returned an invalid claim");
  }
  return claim;
}
