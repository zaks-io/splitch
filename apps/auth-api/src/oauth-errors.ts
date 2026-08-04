/**
 * OAuth-shaped error namespace for the auth doors.
 *
 * WHY a separate shape from `@splitch/contracts` ErrorResponse: the ID-JAG /
 * token-exchange endpoints speak the OAuth 2.0 / auth.md error convention
 * (lowercase `error` + `error_description`, RFC 6749 §5.2 / RFC 8628), NOT the
 * splitch control-plane ErrorResponse discriminated union (uppercase `code`).
 * Forking ErrorResponse to carry these would mix two wire contracts on one body;
 * the auth-protocol surface keeps its own lowercase namespace (access-control-
 * matrix.md: "Unknown `iss` → 401 `unknown_issuer`"). Fail-loud: every failure
 * on the door maps to one of these, never a silent fallthrough.
 */

const oauthErrorCodes = [
  "invalid_request", // malformed body / missing field
  "invalid_client", // bad client_credentials client auth
  "invalid_token", // JWT decode/signature/claim failure
  "unknown_issuer", // `iss` not in trusted_idps (never silently trusted)
  "issuer_disabled", // trusted_idp row exists but enabled = 0 (rejected, not skipped)
  "replayed_jti", // jti already seen in the replay cache
  "invalid_grant", // bad/expired identity_assertion at /oauth2/token
  "unsupported_grant_type", // /oauth2/token grant_type not understood
  "authorization_pending", // device-code poll before the user has approved
  "slow_down", // device-code client is polling faster than allowed
  "expired_token", // device_code/user_code expired before approval
  "interaction_required", // claim email maps to an existing verified user (no merge)
  "access_denied", // Turnstile verification failed (anon register, ADR-0034)
  "email_unverified", // device/AuthKit: provider user has no verified email
  "too_many_requests", // per-IP or global anon-create rate ceiling hit (ADR-0034)
  "server_error", // genuine fault on the door
] as const;

export type OAuthErrorCode = (typeof oauthErrorCodes)[number];

/** The wire body shape. Lowercase `error`, OAuth convention — NOT ErrorResponse. */
export interface OAuthErrorBody {
  error: OAuthErrorCode;
  error_description: string;
  /**
   * `interaction_required` carries the consent link and opaque verification id
   * the human must visit (auth-doors.md). Other codes leave these absent. Kept on the one body shape
   * (not a forked type) so the whole door speaks one error wire contract.
   */
  consent_url?: string;
  consent_expires_at?: string;
  verification_id?: string;
}

/** HTTP status for each OAuth error code (OAuth 2.0 / auth.md mapping). */
const statusByCode: Record<OAuthErrorCode, number> = {
  invalid_request: 400,
  invalid_client: 401,
  invalid_token: 401,
  unknown_issuer: 401,
  issuer_disabled: 401,
  replayed_jti: 401,
  invalid_grant: 400,
  unsupported_grant_type: 400,
  authorization_pending: 400,
  slow_down: 400,
  expired_token: 400,
  interaction_required: 401, // RFC 8628/OIDC: the request needs end-user interaction
  access_denied: 403, // bot challenge (Turnstile) refused the request
  email_unverified: 403, // verify the email with the IdP, then retry login
  too_many_requests: 429,
  server_error: 500,
};

/** Optional extra body fields some codes carry (e.g. the consent link). */
type OAuthErrorExtra = Pick<
  OAuthErrorBody,
  "consent_url" | "consent_expires_at" | "verification_id"
>;

/** A typed door failure carrying its OAuth code + human description. */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly extra: OAuthErrorExtra;
  constructor(code: OAuthErrorCode, description: string, extra: OAuthErrorExtra = {}) {
    super(description);
    this.name = "OAuthError";
    this.code = code;
    this.extra = extra;
  }
  get status(): number {
    return statusByCode[this.code];
  }
  toBody(): OAuthErrorBody {
    return { error: this.code, error_description: this.message, ...this.extra };
  }
}

/** Render an OAuthError as a JSON Response with its canonical status. */
export function renderOAuthError(error: OAuthError): Response {
  return Response.json(error.toBody(), {
    status: error.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Map any thrown door fault to its OAuth body. An OAuthError already carries a
 * caller-actionable code and description; anything else is a bug on the door and
 * collapses to `server_error`.
 *
 * WHY the log: the collapsed body deliberately tells the caller nothing about the
 * internal failure, so without this line the cause leaves no trace at all. The
 * only evidence is a 500 span with an empty error message, and the fault has to
 * be reconstructed from the order of the surrounding subrequest spans. A
 * production ACCESS_TOKEN_SECRET of the wrong shape reached users exactly this
 * way. The caller's body is unchanged; the operator gets the cause.
 */
export function renderDoorFault(cause: unknown): Response {
  if (cause instanceof OAuthError) {
    return renderOAuthError(cause);
  }
  console.error("auth door fault", cause);
  return renderOAuthError(new OAuthError("server_error", "auth door fault"));
}
