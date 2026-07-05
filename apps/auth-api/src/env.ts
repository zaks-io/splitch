/**
 * Auth API Worker bindings. The Worker keeps its own storage handles (D1 for the
 * trusted-IdP allow-list + Org membership, KV for the jti replay cache and
 * session revocation markers) and never hands a raw client to a route — D1
 * access goes through @splitch/db `createRepository`, KV through small helpers.
 */
export interface AuthApiEnv {
  /** D1 binding — wrapped by createRepository, never used raw. */
  DB: D1Database;
  /** KV namespace backing the jti replay cache (`jti:{jti}` keys). */
  JTI_CACHE: KVNamespace;
  /** KV namespace shared with control-plane session validation (`revoked:{sub}`). */
  SESSION_STORE: KVNamespace;
  /** This auth-api origin; every accepted ID-JAG `aud` must point here. */
  AUTH_API_ORIGIN?: string;
  /** Control-plane protected-resource origin stamped as the access token `aud`. */
  CONTROL_PLANE_ORIGIN?: string;
  /**
   * HMAC secret for the short-lived identity_assertion (local fixture). DELIBERATELY
   * distinct from ACCESS_TOKEN_SECRET so an assertion can never verify as a Bearer.
   */
  ASSERTION_SIGNING_SECRET?: string;
  /** HMAC secret for the control-plane access token (local fixture; distinct from above). */
  ACCESS_TOKEN_SECRET?: string;
  /** WorkOS client id used by the device-flow proxy. */
  WORKOS_CLIENT_ID?: string;
  /** WorkOS API key used for server-side refresh-token session revocation. */
  WORKOS_API_KEY?: string;
  /** WorkOS user-management API base URL; defaults to the public WorkOS API. */
  WORKOS_API_BASE_URL?: string;
  /** Shared-preview smoke OAuth client id for non-interactive auth proof. */
  SPLITCH_SMOKE_CLIENT_ID?: string;
  /** Shared-preview smoke OAuth client secret. Never configure for production. */
  SPLITCH_SMOKE_CLIENT_SECRET?: string;
  /** Shared-preview smoke user id stamped into the access token. */
  SPLITCH_SMOKE_USER_ID?: string;
  /** Space-delimited shared-preview smoke access-token scopes. */
  SPLITCH_SMOKE_SCOPES?: string;
  /** Cloudflare Turnstile server-side validation secret. */
  TURNSTILE_SECRET?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SENTRY_DSN?: string;
}
