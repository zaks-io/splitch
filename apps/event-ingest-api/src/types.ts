import type { ErrorResponse } from "@splitch/contracts";
import type {
  EvaluationCommitOutbox,
  EvaluationCommitOutboxNamespace,
} from "./evaluation-commit-outbox";
import type {
  EvaluationUsageReplayWindow,
  EvaluationUsageReplayWindowNamespace,
} from "./evaluation-usage-replay-window";
import type { IngestAdmissionGateNamespace } from "./ingest-admission-gate";
import type { MetricEventOutboxNamespace } from "./metric-event-outbox";
import type { MetricEventRateLimitNamespace } from "./metric-event-rate-limit";

export type Env = {
  CONFIG_STORE?: KVNamespace;
  CREDENTIAL_STORE?: KVNamespace;
  EVALUATION_PRIVACY_SALT?: string;
  INGEST_ADMISSION_GATE?: IngestAdmissionGateNamespace;
  METRIC_EVENT_OUTBOX?: MetricEventOutboxNamespace;
  METRIC_EVENT_RATE_LIMIT?: MetricEventRateLimitNamespace;
  METRIC_EVENTS_QUEUE?: Queue<Record<string, unknown>>;
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_EVENT_INGEST_TOKEN?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SPLITCH_SOURCE_ID?: string;
  TINYBIRD_API_URL?: string;
  TINYBIRD_INGEST_TOKEN?: string;
  EVALUATION_USAGE_REPLAY_WINDOW?:
    | EvaluationUsageReplayWindow
    | EvaluationUsageReplayWindowNamespace;
  EVALUATION_COMMIT_OUTBOX?: EvaluationCommitOutbox | EvaluationCommitOutboxNamespace;
  SENTRY_DSN?: string;
};

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
