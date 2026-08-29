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
}

const STATE_KEY = "metric-event-claim";

export class MetricEventOutboxDurableObject {
  private section = Promise.resolve();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const run = this.section.then(() => this.handle(request));
    this.section = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") return this.read(path);
    if (request.method === "POST") return this.write(path, request);
    return new Response("not found", { status: 404 });
  }

  private async read(path: string): Promise<Response> {
    if (path !== "/lookup" && path !== "/export") {
      return new Response("not found", { status: 404 });
    }
    const existing = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (existing === undefined) return new Response("not found", { status: 404 });
    return path === "/lookup"
      ? Response.json(asLookup(existing))
      : Response.json({ deleted: existing.deleted, row: existing.row ?? null });
  }

  private async write(path: string, request: Request): Promise<Response> {
    if (path === "/suppress") return this.suppress(request);
    if (path !== "/claim") return new Response("not found", { status: 404 });
    const incoming = (await request.json()) as ClaimState;
    const existing = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (existing !== undefined) {
      if (existing.fingerprint !== incoming.fingerprint) {
        return Response.json(asClaim("conflict", existing));
      }
      if (existing.deleted) return Response.json(asClaim("duplicate", existing));
      await this.publish(existing);
      return Response.json(asClaim("duplicate", existing));
    }

    await this.ctx.storage.put(STATE_KEY, incoming);
    await this.publish(incoming);
    return Response.json(asClaim("accepted", incoming));
  }

  private async publish(state: ClaimState): Promise<void> {
    if (state.queued || state.deleted) return;
    if (state.row === undefined) throw new Error("Metric Event outbox row is unavailable");
    if (!this.env.METRIC_EVENTS_QUEUE)
      throw new Error("METRIC_EVENTS_QUEUE binding is unavailable");
    await this.env.METRIC_EVENTS_QUEUE.send(state.row);
    state.queued = true;
    await this.ctx.storage.put(STATE_KEY, state);
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
    await this.ctx.storage.put(STATE_KEY, {
      fingerprint: input.fingerprint,
      eventDefinitionId: existing?.eventDefinitionId ?? input.eventDefinitionId,
      eventDefinitionVersionId:
        existing?.eventDefinitionVersionId ?? input.eventDefinitionVersionId,
      queued: false,
      deleted: true,
    });
    return Response.json({ deleted: true, proof: "metric-event-outbox-redacted-v1" });
  }
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
