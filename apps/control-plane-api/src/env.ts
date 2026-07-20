import type { ConfigStoreDurableObjectNamespace } from "./config-store-do";
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
  /** Cloudflare-native counter keyed by the authenticated Control Plane actor. */
  CONTROL_PLANE_ACTOR_RATE_LIMITER?: RateLimit;
  /** CI-only bearer token for the hosted credential-cache rollout gate. */
  SPLITCH_DEPLOY_GATE_TOKEN?: string;
  /** This control-plane protected-resource origin; the token `aud` must equal it. */
  CONTROL_PLANE_ORIGIN?: string;
  /** Auth-api JWKS endpoint the control-plane token signature is verified against. */
  AUTH_JWKS_URI?: string;
  CONTROL_PANEL_DELEGATION_SECRET?: string;
  CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT?: string;
  CONTROL_PANEL_LEGACY_SESSION_MODE?: string;
  SPLITCH_LOCAL_E2E_RUN_ID?: string;
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SENTRY_DSN?: string;
}
