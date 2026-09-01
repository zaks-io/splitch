import {
  type BeginOutcome,
  beginDelivery,
  isUnresolved,
  type MetricEventDeliveryAttempt,
} from "./metric-event-delivery-attempt";
import type { MetricEventClaim, MetricEventLookup } from "./metric-event-outbox-client";
import { queueRetryDelaySeconds } from "./queue-retry";
import type { Env } from "./types";

interface ClaimState {
  readonly fingerprint: string;
  readonly eventDefinitionId: string;
  readonly eventDefinitionVersionId: string;
  readonly row?: Record<string, unknown>;
  queued: boolean;
  deleted: boolean;
  publishing?: boolean;
  publicationAttempts?: number;
  publicationRetryAt?: number;
  delivery?: MetricEventDeliveryAttempt;
  readonly expiresAt?: number;
}

const STATE_KEY = "metric-event-claim";
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
    if (state.publicationRetryAt !== undefined && state.publicationRetryAt > Date.now()) {
      await this.ctx.storage.setAlarm(state.publicationRetryAt);
      return;
    }
    await this.publish(state, expiresAt);
  }

  private async publish(state: ClaimState, expiresAt: number): Promise<void> {
    if (state.row === undefined) throw new Error("Metric Event outbox row is unavailable");
    if (!this.env.METRIC_EVENTS_QUEUE) {
      throw new Error("METRIC_EVENTS_QUEUE binding is unavailable");
    }

    const publishing = {
      ...state,
      expiresAt,
      publishing: true,
      publicationAttempts: (state.publicationAttempts ?? 0) + 1,
    };
    await this.ctx.storage.put(STATE_KEY, publishing);
    try {
      await this.env.METRIC_EVENTS_QUEUE.send(state.row);
    } catch (error) {
      await this.retryPublication(publishing, error);
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

  private async retryPublication(publishing: ClaimState, error: unknown): Promise<void> {
    const current = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (current === undefined || current.deleted) {
      throw new Error("Metric Event outbox changed during queue publication");
    }
    const publicationAttempts = publishing.publicationAttempts ?? 1;
    const publicationRetryAt =
      Date.now() + queueRetryDelaySeconds(publicationAttempts, publishing.fingerprint) * 1_000;
    await this.ctx.storage.put(STATE_KEY, {
      ...current,
      publishing: false,
      publicationAttempts,
      publicationRetryAt,
    });
    await this.ctx.storage.setAlarm(publicationRetryAt);
    console.error("event-ingest-api Metric Event outbox publication failed", {
      errorMessage: error instanceof Error ? error.message : "non-error rejection",
    });
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
    if (path === "/retain") return this.retainExisting(request);
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

    const accepted = { ...incoming, expiresAt: claimExpiresAt(incoming) };
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
    await this.ctx.storage.setAlarm(
      Math.max(Date.now(), state.publicationRetryAt ?? Number.NEGATIVE_INFINITY),
    );
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

  private async retainExisting(request: Request): Promise<Response> {
    const body = (await request.json()) as { serverReceivedAt?: unknown };
    if (typeof body.serverReceivedAt !== "string") {
      return new Response("invalid Metric Event retention timestamp", { status: 400 });
    }
    const existing = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (existing === undefined) return new Response("not found", { status: 404 });
    const expiresAt = claimExpiresAt(existing, body.serverReceivedAt);
    if (expiresAt <= Date.now()) {
      await this.ctx.storage.delete(STATE_KEY);
      return Response.json({ retained: false, expired: true });
    }
    await this.ctx.storage.put(STATE_KEY, { ...existing, expiresAt });
    await this.ctx.storage.setAlarm(existing.queued || existing.deleted ? expiresAt : Date.now());
    return Response.json({ retained: true, expiresAt });
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
    const stored = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (stored === undefined) {
      throw new Error("Metric Event outbox has no record for a queued delivery");
    }
    const existing = await this.retain(stored);
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
    const input = (await request.json()) as Partial<ClaimState> & {
      serverReceivedAt?: unknown;
    };
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
    const expiresAt = claimExpiresAt(existing ?? input, input.serverReceivedAt);
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

function claimExpiresAt(state: Partial<ClaimState>, suppliedServerReceivedAt?: unknown): number {
  const storedServerReceivedAt = state.row?.server_received_at;
  if (storedServerReceivedAt !== undefined && suppliedServerReceivedAt !== undefined) {
    if (
      typeof storedServerReceivedAt !== "string" ||
      typeof suppliedServerReceivedAt !== "string" ||
      metricEventReceivedAt(storedServerReceivedAt) !==
        metricEventReceivedAt(suppliedServerReceivedAt)
    ) {
      throw new Error("Metric Event retention timestamp conflicts with the sealed row");
    }
  }
  if (state.expiresAt !== undefined) {
    if (!Number.isFinite(state.expiresAt)) throw new Error("Metric Event claim expiry is invalid");
    return state.expiresAt;
  }
  const serverReceivedAt = storedServerReceivedAt ?? suppliedServerReceivedAt;
  if (typeof serverReceivedAt !== "string") {
    throw new Error("Metric Event claim has no retention timestamp");
  }
  return metricEventReceivedAt(serverReceivedAt) + METRIC_EVENT_CLAIM_RETENTION_MS;
}

function metricEventReceivedAt(value: string): number {
  const parsed = Date.parse(
    /^\d{4}-\d{2}-\d{2} /u.test(value) ? `${value.replace(" ", "T")}Z` : value,
  );
  if (!Number.isFinite(parsed))
    throw new Error("Metric Event claim retention timestamp is invalid");
  return parsed;
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
