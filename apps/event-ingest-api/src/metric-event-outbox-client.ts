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

interface MetricEventClaimInput {
  readonly fingerprint: string;
  readonly eventDefinitionId: string;
  readonly eventDefinitionVersionId: string;
  readonly row?: Record<string, unknown>;
  readonly expiresAt?: number;
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
  state: MetricEventClaimInput,
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
