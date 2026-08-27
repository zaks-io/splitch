import type {
  ConvexExposureVerificationRequest,
  ConvexExposureVerificationResult,
} from "@splitch/contracts";
import type { McpDelegationReplayDurableObjectNamespace } from "@splitch/worker-runtime";
import type { HoldoverWriteAppInventoryNamespace } from "./assignment/holdover-write-app-inventory";
import type { HoldoverWriteOutboxNamespace } from "./assignment/holdover-write-outbox";
import type { AssignmentWriterNamespace } from "./assignment/kv-assignment-store";
import type { ExposureRedemptionClaimNamespace } from "./exposure-redemption-claim";
import type { ConfigStoreNamespace } from "./provider/config-updates";

interface ExposureIngestFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ConvexControlPlaneBinding extends ExposureIngestFetcher {
  loadConvexExposureVerificationConfig(
    input: ConvexExposureVerificationRequest,
  ): Promise<ConvexExposureVerificationResult>;
  loadCloudflareExposureVerificationConfig(
    input: ConvexExposureVerificationRequest,
  ): Promise<ConvexExposureVerificationResult>;
}

export interface EvaluationApiEnv {
  ASSIGNMENTS_KV: KVNamespace;
  ASSIGNMENT_STORE_WRITER: AssignmentWriterNamespace;
  CONFIG_STORE: KVNamespace;
  CONFIG_STORE_WRITER?: ConfigStoreNamespace;
  CREDENTIAL_STORE: KVNamespace;
  EVENT_INGEST?: ExposureIngestFetcher;
  CONTROL_PLANE_API: ConvexControlPlaneBinding;
  EVENT_INGEST_URL?: string;
  SESSION_STORE: KVNamespace;
  AUTH_JWKS_URI?: string;
  CONTROL_PLANE_ORIGIN?: string;
  MCP_DELEGATION_REPLAY?: McpDelegationReplayDurableObjectNamespace;
  /** Strongly consistent Exposure Ticket claim DO namespace (SPL-345). */
  EXPOSURE_REDEMPTION_CLAIMS?: ExposureRedemptionClaimNamespace;
  /** Durable Assignment Store holdover retry outbox (SPL-346). */
  HOLDOVER_WRITE_OUTBOX?: HoldoverWriteOutboxNamespace;
  /** App-scoped Entity outbox inventory + deletion coordinator (SPL-346). */
  HOLDOVER_WRITE_APP_INVENTORY?: HoldoverWriteAppInventoryNamespace;
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
  /** Cloudflare Rate Limit binding for per-credential Evaluation traffic. */
  EVALUATION_RATE_LIMITER?: RateLimit;
}
