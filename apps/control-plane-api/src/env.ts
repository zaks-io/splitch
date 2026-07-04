import type { ConfigStoreDurableObjectNamespace } from "./config-store-do.js";

/**
 * Control Plane API Worker bindings.
 *
 * The Worker holds its own storage handles (D1 for Org/App/Environment state and
 * membership, KV for the hot session-validation read) and never hands a raw
 * client to a route: D1 access goes through @splitch/db `createRepository`, KV
 * through the session-store helper. JWKS for control-plane-token verification is
 * fetched from the auth-api authorization-server metadata (HUMAN-SETUP S41 wires
 * the real WorkOS URL; until then the fetcher is injectable for fixtures).
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
  /** This control-plane protected-resource origin; the token `aud` must equal it. */
  CONTROL_PLANE_ORIGIN?: string;
  /** Auth-api JWKS endpoint the control-plane token signature is verified against. */
  AUTH_JWKS_URI?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SENTRY_DSN?: string;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
}
