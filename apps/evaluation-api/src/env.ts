import type { AssignmentWriterNamespace } from "./assignment/kv-assignment-store";
import type { McpDelegationReplayDurableObjectNamespace } from "@splitch/worker-runtime";

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
  MCP_DELEGATION_REPLAY?: McpDelegationReplayDurableObjectNamespace;
  EVALUATION_PRIVACY_SALT?: string;
  /** HMAC key for Exposure Ticket minting (ADR-0048). */
  EXPOSURE_TICKET_KEY?: string;
  /** Previous ticket key retained during rotation so in-flight tickets verify. */
  EXPOSURE_TICKET_KEY_PREVIOUS?: string;
  SPLITCH_EVENT_INGEST_TOKEN?: string;
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SPLITCH_SOURCE_ID?: string;
  SENTRY_DSN?: string;
}
