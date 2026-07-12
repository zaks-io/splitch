import type { Repository } from "@splitch/db";
import type { JtiCache } from "./jti-cache";
import { type DecodedJwt, decodeJwt, type JwksFetcher, verifySignature } from "./jwks";
import { OAuthError } from "./oauth-errors";
import type { WorkOsPort } from "./workos";

/**
 * The ID-JAG validation flow (auth-doors.md "Validation steps", fail-loud on any
 * failure). Every step that can fail throws a typed OAuthError; there is no path
 * that accepts a token with a missing/failed check. The output is the resolved
 * WorkOS user_id, which the route then turns into an identity_assertion.
 */

const DEFAULT_AUTH_TIME_FRESHNESS_SECONDS = 300; // 5 min (auth-doors.md step 5)
const MAX_AUTH_TIME_FORWARD_SKEW_SECONDS = 60; // tolerate minor clock skew, no more

export interface IdJagDeps {
  repo: Repository;
  jtiCache: JtiCache;
  workos: WorkOsPort;
  fetchJwks: JwksFetcher;
  /** This auth-api origin; the ID-JAG `aud` must point here. */
  authApiOrigin: string;
  /** Clock seam so tests pin "now"; defaults to wall clock. */
  now?: () => number;
}

export interface IdJagResult {
  userId: string;
  issuer: string;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new OAuthError("invalid_token", `ID-JAG is missing the "${key}" claim`);
  }
  return value;
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number") {
    throw new OAuthError("invalid_token", `ID-JAG is missing the numeric "${key}" claim`);
  }
  return value;
}

/** Step 4: the token audience must be one of the issuer's registered client_ids. */
function assertAudience(
  payload: Record<string, unknown>,
  clientIds: string[],
  origin: string,
): void {
  const aud = payload.aud;
  const audValues = Array.isArray(aud) ? aud.map(String) : [String(aud)];
  const allowed = new Set([...clientIds, origin]);
  if (!audValues.some((a) => allowed.has(a))) {
    throw new OAuthError("invalid_token", "ID-JAG aud does not match this auth-api / client_ids");
  }
}

/** Steps 5-6: exp not passed, auth_time fresh, and a verified email. */
function assertClaimsFresh(payload: Record<string, unknown>, now: number): void {
  const exp = requireNumber(payload, "exp");
  if (exp <= now) {
    throw new OAuthError("invalid_token", "ID-JAG has expired");
  }
  const authTime = requireNumber(payload, "auth_time");
  if (now - authTime > DEFAULT_AUTH_TIME_FRESHNESS_SECONDS) {
    throw new OAuthError("invalid_token", "ID-JAG auth_time is not fresh enough");
  }
  // Bound the OTHER side too: a far-future auth_time would otherwise pass the
  // staleness check forever. Reject anything beyond minor clock skew (fail-loud).
  if (authTime - now > MAX_AUTH_TIME_FORWARD_SKEW_SECONDS) {
    throw new OAuthError("invalid_token", "ID-JAG auth_time is in the future");
  }
  // Step 8 resolves the WorkOS user by the `email` claim, so a token whose email
  // is unverified must never reach it — even if the IdP verified a phone number,
  // accepting it would bind the splitch identity to an email the presenter never
  // proved control of.
  if (payload.email_verified !== true) {
    throw new OAuthError("invalid_token", "ID-JAG email is not verified");
  }
}

/** Steps 2-3: resolve the issuer in trusted_idps, reject unknown/disabled, verify the signature. */
async function verifyAgainstTrustedIdp(
  deps: IdJagDeps,
  decoded: DecodedJwt,
  issuer: string,
): Promise<string[]> {
  const idp = await deps.repo.privacy.getTrustedIdpByIssuer(issuer);
  if (!idp) {
    throw new OAuthError("unknown_issuer", `issuer "${issuer}" is not a trusted IdP`);
  }
  if (!idp.enabled) {
    throw new OAuthError("issuer_disabled", `trusted IdP "${issuer}" is disabled`);
  }
  const jwks = await deps.fetchJwks(idp.jwksUri);
  await verifySignature(decoded, jwks);
  return JSON.parse(idp.clientIds) as string[];
}

/** Run the full ID-JAG door for one signed assertion. Returns the resolved user. */
export async function verifyIdJag(deps: IdJagDeps, idJag: string): Promise<IdJagResult> {
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);

  // Step 1: decode header + payload, extract the issuer.
  const decoded = decodeJwt(idJag);
  const issuer = requireString(decoded.payload, "iss");

  // Steps 2-3: trusted-IdP lookup (unknown/disabled fail loud) + signature verify.
  const clientIds = await verifyAgainstTrustedIdp(deps, decoded, issuer);

  // Steps 4-6: audience, expiry/freshness, verified contact.
  assertAudience(decoded.payload, clientIds, deps.authApiOrigin);
  assertClaimsFresh(decoded.payload, now);

  // Step 7: jti replay cache (a replayed jti is rejected).
  const exp = requireNumber(decoded.payload, "exp");
  await deps.jtiCache.assertFreshAndRecord(requireString(decoded.payload, "jti"), exp, now);

  // Step 8: resolve-or-create the WorkOS user by verified email.
  const userId = await deps.workos.resolveOrCreateUser(requireString(decoded.payload, "email"));

  return { userId, issuer };
}
