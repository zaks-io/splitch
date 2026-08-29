import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/sdk/control-plane";
import { SplitchCliError } from "./errors.js";

export { MEMBERSHIP_WIDE_READ_AUTHORIZATION };

/** The selector a minted access token is bound to through the refresh grant. */
export interface TokenBinding {
  readonly kind: "app" | "org";
  readonly selector: string;
}

interface MembershipWideReadAuthorization {
  readonly kind: typeof MEMBERSHIP_WIDE_READ_AUTHORIZATION;
}

export type TokenAuthorization = TokenBinding | MembershipWideReadAuthorization;

/**
 * The cache label for the minted authority. An empty key is the unbound or
 * legacy session token preserved when no explicit selector was requested.
 */
export function bindingKey(authorization: TokenAuthorization | null): string {
  if (!authorization) return "";
  return authorization.kind === MEMBERSHIP_WIDE_READ_AUTHORIZATION
    ? MEMBERSHIP_WIDE_READ_AUTHORIZATION
    : `${authorization.kind}:${authorization.selector}`;
}

export function bindingParams(authorization: TokenAuthorization | null): Record<string, string> {
  if (!authorization) return {};
  return authorization.kind === MEMBERSHIP_WIDE_READ_AUTHORIZATION
    ? { authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION }
    : { [authorization.kind]: authorization.selector };
}

export interface OAuthFault {
  readonly status: number;
  readonly error?: string;
  readonly description?: string;
  readonly refreshToken?: string;
}

/**
 * True when the auth service refused to mint a token because the selected
 * App/Organization is outside live membership (or the selector is ambiguous).
 * Distinct from a dead refresh session: re-login cannot fix these refusals.
 *
 * The CLI only claims this cause when the server's own reason text establishes
 * it. Unrecognized or opaque `invalid_grant` bodies stay session-expiry — the
 * CLI must not invent a binding refusal it has not proven.
 */
export function isTokenBindingRefusal(fault: OAuthFault): boolean {
  if (fault.error !== "invalid_grant") {
    return false;
  }
  const description = fault.description?.trim() ?? "";
  if (description.length === 0) {
    return false;
  }
  return isMembershipBindingRefusalDescription(description);
}

/**
 * Auth-api membership-authority refusal reasons (verbatim substrings). Keep
 * this allow-list tight so WorkOS passthrough / unknown invalid_grant text
 * cannot be mislabeled as a binding problem.
 */
function isMembershipBindingRefusalDescription(description: string): boolean {
  return (
    /not authorized by live membership/i.test(description) ||
    /not reachable by live membership/i.test(description) ||
    /matches more than one App/i.test(description)
  );
}

/**
 * Read the OAuth error body off a failed auth response. The body is the
 * diagnosis ("invalid_client: Unknown client."), so an auth failure that
 * reports only an HTTP status is a fail-loud violation — never discard it.
 */
export async function readOAuthFault(response: Response): Promise<OAuthFault> {
  try {
    const body = (await response.json()) as {
      error?: unknown;
      error_description?: unknown;
      refresh_token?: unknown;
    };
    return {
      status: response.status,
      error: readFaultText(body.error),
      description: readFaultText(body.error_description),
      refreshToken: readFaultText(body.refresh_token),
    };
  } catch {
    return { status: response.status };
  }
}

/**
 * OAuth fault text is remote input printed straight to a terminal. Strip the
 * C0/C1 control range so a hostile or misconfigured auth origin cannot use
 * escape sequences to rewrite the line and disguise the failure.
 */
function readFaultText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return clean.slice(0, 300) || undefined;
}

/**
 * True when the OAuth error body itself proves the session is gone: the auth
 * service returned `invalid_grant`, meaning it looked at the refresh token
 * and refused it (a plain dead session, or -- one call site up, before this
 * runs -- a membership/binding refusal). Any other fault (a 5xx, a body with
 * no `error` at all, or an error we don't recognize) proves nothing about the
 * session either way, so it must never be read as a refusal (ADR-0036).
 */
export function isSessionRefusal(fault: OAuthFault): boolean {
  return fault.error === "invalid_grant";
}

export function describeOAuthFault(fault: OAuthFault): string {
  const parts = [`HTTP ${fault.status}`];
  if (fault.error) parts.push(fault.error);
  if (fault.description) parts.push(fault.description);
  return parts.join(": ");
}

export function deviceAuthorizationError(fault: OAuthFault): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_DEVICE_AUTHORIZATION_FAILED",
    causeSummary: `Device authorization failed with ${describeOAuthFault(fault)}`,
    remediation: "Check the auth service response above, then run splitch login again",
  });
}
