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
  readonly row: Record<string, unknown>;
  queued: boolean;
}

const STATE_KEY = "metric-event-claim";

export class MetricEventOutboxDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/lookup") {
      const existing = await this.ctx.storage.get<ClaimState>(STATE_KEY);
      if (existing === undefined) return new Response("not found", { status: 404 });
      return Response.json(asLookup(existing));
    }
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const incoming = (await request.json()) as ClaimState;
    const existing = await this.ctx.storage.get<ClaimState>(STATE_KEY);
    if (existing !== undefined) {
      if (existing.fingerprint !== incoming.fingerprint) {
        return Response.json(asClaim("conflict", existing));
      }
      await this.publish(existing);
      return Response.json(asClaim("duplicate", existing));
    }

    await this.ctx.storage.put(STATE_KEY, incoming);
    await this.publish(incoming);
    return Response.json(asClaim("accepted", incoming));
  }

  private async publish(state: ClaimState): Promise<void> {
    if (state.queued) return;
    if (!this.env.METRIC_EVENTS_QUEUE)
      throw new Error("METRIC_EVENTS_QUEUE binding is unavailable");
    await this.env.METRIC_EVENTS_QUEUE.send(state.row);
    state.queued = true;
    await this.ctx.storage.put(STATE_KEY, state);
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
  state: Omit<ClaimState, "queued">,
): Promise<MetricEventClaim> {
  if (!namespace) throw new Error("METRIC_EVENT_OUTBOX binding is unavailable");
  const response = await namespace
    .get(namespace.idFromName(dedupKey))
    .fetch("https://metric-event-outbox.local/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...state, queued: false }),
    });
  if (!response.ok) throw new Error(`Metric Event outbox returned HTTP ${response.status}`);
  const claim = (await response.json()) as MetricEventClaim;
  if (!["accepted", "duplicate", "conflict"].includes(claim.outcome)) {
    throw new Error("Metric Event outbox returned an invalid claim");
  }
  return claim;
}
