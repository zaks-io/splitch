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
  /** KV namespace backing the session-validation hot read (revocation markers). */
  SESSION_STORE: KVNamespace;
  /** This control-plane protected-resource origin; the token `aud` must equal it. */
  CONTROL_PLANE_ORIGIN?: string;
  /** Auth-api JWKS endpoint the control-plane token signature is verified against. */
  AUTH_JWKS_URI?: string;
  SPLITCH_PLATFORM_TARGET?: string;
}
