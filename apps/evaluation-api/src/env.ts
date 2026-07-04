import type { AssignmentWriterNamespace } from "./assignment/kv-assignment-store";

interface ExposureIngestFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface EvaluationApiEnv {
  ASSIGNMENTS_KV: KVNamespace;
  ASSIGNMENT_STORE_WRITER: AssignmentWriterNamespace;
  CONFIG_STORE: KVNamespace;
  CREDENTIAL_STORE: KVNamespace;
  EVENT_INGEST?: ExposureIngestFetcher;
  EVENT_INGEST_URL?: string;
  SESSION_STORE: KVNamespace;
  AUTH_JWKS_URI?: string;
  CONTROL_PLANE_ORIGIN?: string;
  EVALUATION_PRIVACY_SALT?: string;
  SPLITCH_EVENT_INGEST_TOKEN?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SPLITCH_SOURCE_ID?: string;
  SENTRY_DSN?: string;
}
