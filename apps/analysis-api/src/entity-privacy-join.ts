/**
 * Analysis consumer for ADR-0044 retained identity epochs.
 *
 * Public Entity export/delete HTTP remains unavailable
 * (`entity_privacy_export` / `entity_privacy_delete` stay 503). This joins
 * already-authenticated analysis rows for one Entity across every retained
 * hash without inventing a new public API shape.
 */

import {
  type EntityPrivacyInput,
  joinMetricEventsToExposures,
  resolveEntityPrivacyIdentity,
  type SaltStore,
} from "@splitch/privacy";

export interface EntityAnalysisRow {
  targeting_key_hash: string;
}

export async function joinRetainedEntityAnalysis<
  Exposure extends EntityAnalysisRow,
  MetricEvent extends EntityAnalysisRow,
>(
  saltStore: SaltStore,
  input: EntityPrivacyInput,
  exposures: readonly Exposure[],
  metricEvents: readonly MetricEvent[],
): Promise<{
  appId: string;
  targetingKeyHashes: readonly string[];
  exposures: Exposure[];
  metricEvents: MetricEvent[];
}> {
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  const joined = joinMetricEventsToExposures(exposures, metricEvents, identity.targetingKeyHashes);
  return {
    appId: identity.appId,
    targetingKeyHashes: identity.targetingKeyHashes,
    exposures: joined.exposures,
    metricEvents: joined.metricEvents,
  };
}
