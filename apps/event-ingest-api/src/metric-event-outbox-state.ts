import type { MetricEventDeliveryAttempt } from "./metric-event-delivery-attempt";
import type { MetricEventClaim, MetricEventLookup } from "./metric-event-outbox-client";

export interface MetricEventClaimState {
  readonly fingerprint: string;
  readonly eventDefinitionId: string;
  readonly eventDefinitionVersionId: string;
  readonly row?: Record<string, unknown>;
  readonly activationRows?: readonly Record<string, unknown>[];
  readonly activatedRuns?: number;
  queued: boolean;
  metricQueued?: boolean;
  activationsQueued?: boolean;
  deleted: boolean;
  publishing?: boolean;
  publicationAttempts?: number;
  publicationRetryAt?: number;
  delivery?: MetricEventDeliveryAttempt;
  readonly expiresAt?: number;
}

export function asMetricEventClaim(
  outcome: MetricEventClaim["outcome"],
  state: MetricEventClaimState,
): MetricEventClaim {
  return {
    outcome,
    eventDefinitionId: state.eventDefinitionId,
    eventDefinitionVersionId: state.eventDefinitionVersionId,
    activatedRuns: state.activatedRuns ?? 0,
  };
}

export function asMetricEventLookup(state: MetricEventClaimState): MetricEventLookup {
  return {
    fingerprint: state.fingerprint,
    eventDefinitionId: state.eventDefinitionId,
    eventDefinitionVersionId: state.eventDefinitionVersionId,
    activatedRuns: state.activatedRuns ?? 0,
  };
}

export function metricEventReceivedAt(value: string): number {
  const parsed = Date.parse(
    /^\d{4}-\d{2}-\d{2} /u.test(value) ? `${value.replace(" ", "T")}Z` : value,
  );
  if (!Number.isFinite(parsed)) {
    throw new Error("Metric Event claim retention timestamp is invalid");
  }
  return parsed;
}
