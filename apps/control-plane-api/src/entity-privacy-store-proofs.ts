const proofPrefixes = {
  entity_analysis_privacy_suppress: ["entity_deletions:"],
  entity_analysis_privacy_export: [
    "tinybird:raw_events:",
    "tinybird:metric_events:",
    "tinybird:deduped_exposures:",
    "tinybird:deduped_metric_events_state:",
  ],
  entity_analysis_privacy_delete: [
    "tinybird:raw_events:",
    "tinybird:metric_events:",
    "tinybird:deduped_exposures:",
    "tinybird:deduped_metric_events_state:",
  ],
  entity_event_privacy_export: [
    "metric-event-outbox-inventory:",
    "evaluation-commit-outbox-inventory:",
  ],
  entity_event_privacy_suppress: ["metric-event-queue-suppression:"],
  entity_event_privacy_delete: [
    "metric-event-outbox-redaction:",
    "evaluation-commit-outbox-redaction:",
    "metric-event-queue:",
  ],
} as const;

export interface EntityPrivacyPageInput {
  limit: number;
  cursor: string | null;
}

export function isPrivacyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasRawTargetingKey(value: object): value is { targetingKey: string } {
  return "targetingKey" in value;
}

export function privacyStoreProofPrefixes(operationId: string): readonly string[] | undefined {
  return proofPrefixes[operationId as keyof typeof proofPrefixes];
}
