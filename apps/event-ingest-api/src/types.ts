import type { ErrorResponse } from "@splitch/contracts";
import type { EntityMetricPrivacyNamespace } from "./entity-metric-privacy";
import type {
  EvaluationCommitOutbox,
  EvaluationCommitOutboxNamespace,
} from "./evaluation-commit-outbox-contract";
import type {
  EvaluationUsageReplayWindow,
  EvaluationUsageReplayWindowNamespace,
} from "./evaluation-usage-replay-window";
import type { IngestAdmissionGateNamespace } from "./ingest-admission-gate";
import type { MetricEventClaimRetentionBackfillNamespace } from "./metric-event-claim-retention-backfill";
import type { MetricEventOutboxNamespace } from "./metric-event-outbox-client";
import type { MetricEventRateLimitNamespace } from "./metric-event-rate-limit";

interface WorkerProtocolBindings {
  CONFIG_STORE?: KVNamespace;
  CONFIG_STORE_WRITER?: {
    getByName(name: string): {
      readAppIdentity?(
        appId: string,
        options?: { readonly lease: true },
      ): Promise<string | null | { readonly value: string | null; readonly expiresAt: number }>;
      putAppIdentityIfAbsent?(appId: string, value: string): Promise<string>;
    };
  };
  CREDENTIAL_STORE?: KVNamespace;
  EVALUATION_PRIVACY_SALT?: string;
  INGEST_ADMISSION_GATE?: IngestAdmissionGateNamespace;
  METRIC_EVENT_OUTBOX?: MetricEventOutboxNamespace;
  METRIC_EVENT_CLAIM_RETENTION_BACKFILL?: MetricEventClaimRetentionBackfillNamespace;
  METRIC_EVENT_RATE_LIMIT?: MetricEventRateLimitNamespace;
  ENTITY_METRIC_PRIVACY?: EntityMetricPrivacyNamespace;
  RAW_EVENTS_QUEUE?: Queue<Record<string, unknown>>;
  RAW_EVENTS_DLQ?: Queue<Record<string, unknown>>;
  RAW_EVALUATIONS_QUEUE?: Queue<Record<string, unknown>>;
  RAW_EVALUATIONS_DLQ?: Queue<Record<string, unknown>>;
  METRIC_EVENTS_QUEUE?: Queue<Record<string, unknown>>;
  METRIC_EVENTS_DLQ?: Queue<Record<string, unknown>>;
  METRIC_EVENTS_RECONCILIATION_QUEUE?: Queue<Record<string, unknown>>;
  METRIC_EVENTS_RECONCILIATION_DLQ?: Queue<Record<string, unknown>>;
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_EVENT_INGEST_TOKEN?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SPLITCH_SOURCE_ID?: string;
  TINYBIRD_API_URL?: string;
  TINYBIRD_INGEST_TOKEN?: string;
  TINYBIRD_READ_TOKEN?: string;
  TINYBIRD_COPY_TOKEN?: string;
  EVALUATION_USAGE_REPLAY_WINDOW?:
    | EvaluationUsageReplayWindow
    | EvaluationUsageReplayWindowNamespace;
  EVALUATION_COMMIT_OUTBOX?: EvaluationCommitOutbox | EvaluationCommitOutboxNamespace;
  SENTRY_DSN?: string;
}

/** Wrangler owns platform binding types; this layer only adds protocol-rich stubs and injected vars. */
export type Env = Partial<Omit<Cloudflare.Env, keyof WorkerProtocolBindings>> &
  WorkerProtocolBindings;

export type Payload = Record<string, unknown>;

export interface CredentialScope {
  readonly appId: string;
  readonly environmentId: string;
}

export interface EvaluationUsageScope extends CredentialScope {
  readonly organizationId: string;
}

export interface RunScope {
  readonly runId: string;
  readonly idType: string;
}

export interface TinybirdDelivery {
  readonly url: string;
  readonly token: string;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: ErrorResponse };
