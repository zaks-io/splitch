import type { McpDelegationReplayDurableObjectNamespace } from "@splitch/worker-runtime";
import type { ConfigStoreDurableObjectNamespace } from "./config-store-do";

interface AnalysisControlPlaneBinding extends Fetcher {
  purgeAppIdentityAnalytics(appId: string): Promise<string>;
}

interface EvaluationControlPlaneBinding extends Fetcher {
  purgeAppIdentityAssignments(appId: string, resetId: string): Promise<string>;
  purgeAppIdentityRetryClaims(appId: string, environmentIds: readonly string[]): Promise<string>;
  completeAppIdentityReset(appId: string, resetId: string): Promise<void>;
}

interface EventIngestControlPlaneBinding extends Fetcher {
  purgeAppIdentityDelivery(appId: string, resetId: string): Promise<string>;
  completeAppIdentityReset(appId: string, resetId: string): Promise<void>;
}
import type { CredentialCacheBackfillDurableObjectNamespace } from "./credential-cache-backfill-do";
import type { CredentialCacheWriterDurableObjectNamespace } from "./credential-cache-writer-do";
import type { PanelDelegationReplayDurableObjectNamespace } from "./panel-identity-replay";

/**
 * Control Plane API Worker bindings.
 *
 * The Worker holds its own storage handles (D1 for Org/App/Environment state and
 * membership, KV for the hot session-validation read) and never hands a raw
 * client to a route: D1 access goes through @splitch/db `createRepository`, KV
 * through the session-store helper. JWKS for control-plane-token verification is
 * fetched from the auth-api authorization-server metadata. The URI comes from
 * environment configuration; tests inject a fixture fetcher.
 */
export interface ControlPlaneApiEnv {
  /** D1 binding — wrapped by createRepository, never used raw. */
  DB: D1Database;
  /** KV namespace backing session-validation revocation markers and session identity profiles. */
  SESSION_STORE: KVNamespace;
  /** KV namespace backing schema-versioned config cache reads. */
  CONFIG_STORE: KVNamespace;
  /** KV namespace backing SDK credential hot-validation cache entries. */
  CREDENTIAL_STORE: KVNamespace;
  /** Per-App/Environment config writer and live-update nudge fan-out. */
  CONFIG_STORE_WRITER: ConfigStoreDurableObjectNamespace;
  CREDENTIAL_CACHE_WRITER: CredentialCacheWriterDurableObjectNamespace;
  CREDENTIAL_CACHE_BACKFILL: CredentialCacheBackfillDurableObjectNamespace;
  PANEL_DELEGATION_REPLAY: PanelDelegationReplayDurableObjectNamespace;
  /** Strongly consistent one-use claims for binding-only MCP delegations. */
  MCP_DELEGATION_REPLAY?: McpDelegationReplayDurableObjectNamespace;
  /** Cloudflare-native counter keyed by the authenticated Control Plane actor. */
  CONTROL_PLANE_ACTOR_RATE_LIMITER?: RateLimit;
  /** Binding-only ControlPlaneEntrypoint on the Analysis Worker (ADR-0046). */
  ANALYSIS_API: AnalysisControlPlaneBinding;
  /** Binding-only ControlPlaneEntrypoint on the Evaluation Worker (ADR-0046). */
  EVALUATION_API: EvaluationControlPlaneBinding;
  /** Binding-only ControlPlaneEntrypoint on Event Ingest for Entity suppression and outbox purge. */
  EVENT_INGEST_API: EventIngestControlPlaneBinding;
  /** CI-only bearer token for the hosted credential-cache rollout gate. */
  SPLITCH_DEPLOY_GATE_TOKEN?: string;
  /** This control-plane protected-resource origin; the token `aud` must equal it. */
  CONTROL_PLANE_ORIGIN?: string;
  TINYBIRD_API_URL?: string;
  TINYBIRD_RUN_SNAPSHOT_TOKEN?: string;
  TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN?: string;
  TINYBIRD_APPROVAL_ARCHIVE_READ_TOKEN?: string;
  /** Auth-api JWKS endpoint the control-plane token signature is verified against. */
  AUTH_JWKS_URI?: string;
  CONTROL_PANEL_DELEGATION_SECRET?: string;
  CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT?: string;
  CONTROL_PANEL_LEGACY_SESSION_MODE?: string;
  CONVEX_WEBHOOK_KEK?: string;
  CONVEX_WEBHOOK_KEY_VERSION?: string;
  INTEGRATION_SECRET_KEK?: string;
  INTEGRATION_SECRET_KEY_VERSION?: string;
  /**
   * Extra hosts the Sentry change-tracking webhook may target, comma-separated,
   * for self-hosted Sentry. Empty means sentry.io and its regional subdomains
   * only. Never a wildcard: this is the SSRF boundary on a customer-supplied URL.
   */
  SENTRY_WEBHOOK_ALLOWED_HOSTS?: string;
  /** Verifies signed one-call credentials accepted only by McpEntrypoint. */
  MCP_CONTROL_PLANE_DELEGATION_SECRET?: string;
  SPLITCH_LOCAL_E2E_RUN_ID?: string;
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SENTRY_DSN?: string;
  EVALUATION_PRIVACY_SALT?: string;
}
