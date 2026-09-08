import type { Repository } from "@splitch/db";
import { decodeJwt } from "./jwks";
import { jwksUrlError } from "./jwks-url";
import type { SecurityEventReceiptStore } from "./security-event-receipts";

const REVOCATION_EVENT = "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked";
const MAX_EVENT_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_FORWARD_SKEW_SECONDS = 60;

export interface SecurityEventDeps {
  repo: Pick<Repository, "privacy">;
  receiptStore: SecurityEventReceiptStore;
  authApiOrigin: string;
  now: () => number;
  verifyRemoteSignature(jwksUri: string, compactJws: string): Promise<boolean>;
}

export class SecurityEventError extends Error {
  constructor(
    readonly err: string,
    message: string,
  ) {
    super(message);
  }
}

/** Verify one provider SET. Door A is paused, so no provider registration can currently match it. */
export async function processSecurityEventToken(
  deps: SecurityEventDeps,
  compactSet: string,
): Promise<{ duplicate: boolean; recognized: boolean }> {
  const decoded = decodeSecurityEvent(compactSet);
  const issuer = requiredString(decoded.payload, "iss");
  const jwksUri = await trustedJwksUri(deps.repo, issuer);
  if (!(await deps.verifyRemoteSignature(jwksUri, compactSet))) {
    throw new SecurityEventError("invalid_request", "SET signature is invalid");
  }
  const { jti, events } = validateSecurityEventClaims(
    decoded.payload,
    deps.authApiOrigin,
    Math.floor(deps.now() / 1000),
  );
  if (await deps.receiptStore.seenOrRecord(issuer, jti)) {
    return { duplicate: true, recognized: REVOCATION_EVENT in events };
  }

  // Door A is deliberately paused and cannot issue an (iss, sub, aud) provider
  // registration. A verified revocation therefore has no active credential to
  // invalidate today. Activation must add that registration consumer first.
  return { duplicate: false, recognized: REVOCATION_EVENT in events };
}

function decodeSecurityEvent(compactSet: string): ReturnType<typeof decodeJwt> {
  let decoded: ReturnType<typeof decodeJwt>;
  try {
    decoded = decodeJwt(compactSet);
  } catch {
    throw new SecurityEventError("invalid_request", "SET is not a compact JWS");
  }
  if (decoded.header.typ !== "secevent+jwt") {
    throw new SecurityEventError("invalid_request", "SET typ must be secevent+jwt");
  }
  if (!decoded.header.kid) {
    throw new SecurityEventError("invalid_request", "SET is missing a key id");
  }
  if (decoded.header.alg !== "RS256" && decoded.header.alg !== "ES256") {
    throw new SecurityEventError("invalid_request", "SET signing algorithm is not allowed");
  }
  return decoded;
}

async function trustedJwksUri(repo: Pick<Repository, "privacy">, issuer: string): Promise<string> {
  const idp = await repo.privacy.getTrustedIdpByIssuer(issuer);
  if (!idp?.enabled) {
    throw new SecurityEventError("invalid_request", "SET issuer is not trusted");
  }
  if (jwksUrlError(idp.jwksUri)) {
    throw new SecurityEventError("invalid_request", "SET issuer JWKS URI is not allowed");
  }
  return idp.jwksUri;
}

function validateSecurityEventClaims(
  payload: Record<string, unknown>,
  authApiOrigin: string,
  now: number,
): { jti: string; events: Record<string, unknown> } {
  requiredString(payload, "sub");
  const jti = requiredString(payload, "jti");
  if (!includesAudience(payload.aud, authApiOrigin)) {
    throw new SecurityEventError("invalid_request", "SET audience does not match this service");
  }
  const issuedAt = requiredInteger(payload, "iat");
  if (issuedAt > now + MAX_FORWARD_SKEW_SECONDS || issuedAt < now - MAX_EVENT_AGE_SECONDS) {
    throw new SecurityEventError(
      "invalid_request",
      "SET issued-at time is outside the accepted window",
    );
  }
  const expiresAt = optionalNumericDate(payload, "exp");
  if (expiresAt !== undefined && expiresAt <= now) {
    throw new SecurityEventError("invalid_request", "SET has expired");
  }
  const events = payload.events;
  if (!isNonEmptyRecord(events)) {
    throw new SecurityEventError("invalid_request", "SET events claim must be an object");
  }
  return { jti, events };
}

function includesAudience(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((audience) => typeof audience === "string") &&
    value.includes(expected)
  );
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SecurityEventError("invalid_request", `SET is missing the ${key} claim`);
  }
  return value;
}

function requiredInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SecurityEventError("invalid_request", `SET is missing the integer ${key} claim`);
  }
  return value;
}

function optionalNumericDate(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SecurityEventError("invalid_request", `SET ${key} claim must be a NumericDate`);
  }
  return value;
}
