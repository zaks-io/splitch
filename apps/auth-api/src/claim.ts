import type { Repository } from "@splitch/db";
import { normalizeEmail } from "./email";
import { OAuthError } from "./oauth-errors";
import type { RateLimiter } from "./rate-limit";
import type { TokenSigner } from "./token-exchange";
import type { WorkOsPort } from "./workos";

const OTP_TTL_MS = 10 * 60 * 1000;
const CONSENT_TTL_MS = 15 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

export interface ClaimDeps {
  repo: Repository;
  workos: WorkOsPort;
  tokenSigner: TokenSigner;
  rateLimiter: RateLimiter;
  consentBaseUrl: string;
  now: () => number;
  /** Legacy local fixture seams; hosted claims never use them. */
  otp?: unknown;
  idempotency?: unknown;
}

export interface InitiateInput {
  identityAssertion: string;
  email: string;
  remoteIp: string | undefined;
}

export interface VerifyInput extends InitiateInput {
  otp: string;
  verificationId?: string;
  idempotencyKey: string;
}

export interface ClaimResult {
  access_token: string;
  user_id: string;
  org_id: string;
  app_id: string;
}

interface Provisional {
  userId: string;
  orgId: string;
  appId: string;
  email: string;
}

export async function initiateClaim(
  deps: ClaimDeps,
  input: InitiateInput,
): Promise<{ otp_required: true; verification_id: string; user_id: string; org_id: string }> {
  const now = deps.now();
  deps.rateLimiter.assertUnderCeiling(input.remoteIp ?? "unknown", now);
  const claimant = await resolveIdentity(deps, input.identityAssertion, input.email, now);
  await assertStillProvisional(deps, claimant.orgId);
  const hashes = await claimHashes(claimant.userId, claimant.email);
  const verificationId = `cver_${crypto.randomUUID()}`;
  await deps.workos.sendEmailVerification(claimant.userId, claimant.email);
  await deps.repo.claim.createVerification({
    ...hashes,
    id: verificationId,
    expiresAt: iso(now + OTP_TTL_MS),
    now: iso(now),
  });
  return {
    otp_required: true,
    verification_id: verificationId,
    user_id: claimant.userId,
    org_id: claimant.orgId,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the ordered security gates are deliberately kept in one auditable ceremony.
export async function verifyClaim(deps: ClaimDeps, input: VerifyInput): Promise<ClaimResult> {
  const now = deps.now();
  deps.rateLimiter.assertUnderCeiling(input.remoteIp ?? "unknown", now);
  const claimant = await resolveIdentity(deps, input.identityAssertion, input.email, now);
  const hashes = await claimHashes(claimant.userId, claimant.email);
  const keyHash = await hashIdentifier(input.idempotencyKey);
  const nowIso = iso(now);
  const existing = await deps.workos.findVerifiedUserByEmail(claimant.email);
  if (await deps.repo.claim.completedClaim({ ...hashes, keyHash, now: nowIso })) {
    return tokenize(
      deps,
      claimant,
      existing && existing !== claimant.userId ? existing : claimant.userId,
      now,
    );
  }
  const verification = input.verificationId
    ? await deps.repo.claim.getVerification(input.verificationId)
    : await deps.repo.claim.getLatestVerification(hashes);
  if (
    !verification ||
    verification.provisionalUserHash !== hashes.provisionalUserHash ||
    verification.emailHash !== hashes.emailHash ||
    verification.consumedAt ||
    verification.expiresAt <= nowIso
  ) {
    throw new OAuthError(
      "invalid_grant",
      "claim verification is expired or does not match this identity",
    );
  }
  const existingHash = existing ? await hashIdentifier(existing) : null;
  if (!verification.verifiedAt) {
    if (
      !(await deps.repo.claim.incrementAttempt({
        ...hashes,
        id: verification.id,
        now: nowIso,
        maxAttempts: MAX_OTP_ATTEMPTS,
      }))
    ) {
      throw new OAuthError("invalid_grant", "OTP attempt limit reached; request a new code");
    }
    try {
      await deps.workos.confirmEmailVerification(claimant.userId, claimant.email, input.otp);
    } catch {
      throw new OAuthError("invalid_grant", "WorkOS rejected the email verification code");
    }
    if (!(await deps.repo.claim.markVerified({ ...hashes, id: verification.id, now: nowIso }))) {
      throw new OAuthError("server_error", "claim verification changed during confirmation");
    }
  }
  const approvedConsent =
    existing && existing !== claimant.userId
      ? await deps.repo.claim.getApprovedConsent({
          verificationId: verification.id,
          existingUserHash: existingHash as string,
          now: nowIso,
        })
      : null;
  if (existing && existing !== claimant.userId && !approvedConsent) {
    const consentId = `ccons_${crypto.randomUUID()}`;
    await deps.repo.claim.createConsentAttempt({
      id: consentId,
      verificationId: verification.id,
      existingUserHash: existingHash as string,
      expiresAt: iso(now + CONSENT_TTL_MS),
      now: nowIso,
    });
    throw new OAuthError("interaction_required", "the email owner must approve linking", {
      consent_url: `${deps.consentBaseUrl}/claim/consent/${consentId}`,
      consent_expires_at: iso(now + CONSENT_TTL_MS),
    });
  }
  const verifiedUserId = existing && existing !== claimant.userId ? existing : claimant.userId;
  const transfer = {
    ...hashes,
    verificationId: verification.id,
    consentAttemptId: approvedConsent,
    keyHash,
    provisionalUserId: claimant.userId,
    verifiedUserId,
    orgId: claimant.orgId,
    now: nowIso,
    expiresAt: iso(now + IDEMPOTENCY_TTL_MS),
  };
  let applied = false;
  try {
    applied = await deps.repo.claim.completeClaim(transfer);
  } catch {
    if (await deps.repo.claim.completedClaim({ ...hashes, keyHash, now: nowIso })) {
      return tokenize(deps, claimant, verifiedUserId, now);
    }
    throw new OAuthError("invalid_request", "a claim with this idempotency_key is in progress");
  }
  if (!applied) throw new OAuthError("invalid_grant", "claim state changed during transfer");
  return tokenize(deps, claimant, verifiedUserId, now);
}

export async function approveClaimConsent(
  deps: ClaimDeps,
  consentAttemptId: string,
  workosUserId: string,
): Promise<void> {
  if (
    !(await deps.repo.claim.approveConsent({
      id: consentAttemptId,
      existingUserHash: await hashIdentifier(workosUserId),
      now: iso(deps.now()),
    }))
  ) {
    throw new OAuthError(
      "invalid_grant",
      "claim consent is expired or does not belong to this user",
    );
  }
}

async function resolveIdentity(
  deps: ClaimDeps,
  assertion: string,
  email: string,
  now: number,
): Promise<Provisional> {
  const identity = await deps.tokenSigner.verifyIdentityAssertion(
    assertion,
    Math.floor(now / 1000),
  );
  const appId = identity.scopes
    .map((scope) => scope.split(":"))
    .find((part) => part.length === 3 && part[0] === "app")?.[1];
  if (!appId)
    throw new OAuthError("invalid_grant", "identity_assertion carries no pre-claim App scope");
  const app = await deps.repo.identity.getApp(appId);
  if (!app) throw new OAuthError("invalid_grant", "pre-claim App no longer exists");
  return {
    userId: identity.userId,
    orgId: app.organizationId,
    appId,
    email: normalizeEmail(email),
  };
}

async function assertStillProvisional(deps: ClaimDeps, orgId: string) {
  if (!(await deps.repo.identity.getOrg(orgId))?.isProvisional)
    throw new OAuthError("invalid_grant", "workspace is not awaiting a claim");
}

async function tokenize(
  deps: ClaimDeps,
  claimant: Provisional,
  userId: string,
  now: number,
): Promise<ClaimResult> {
  return {
    access_token: await deps.tokenSigner.mintAccessToken(
      userId,
      [`app:${claimant.appId}:owner`],
      "anonymous",
      Math.floor(now / 1000),
    ),
    user_id: userId,
    org_id: claimant.orgId,
    app_id: claimant.appId,
  };
}

async function claimHashes(userId: string, email: string) {
  return {
    provisionalUserHash: await hashIdentifier(userId),
    emailHash: await hashIdentifier(email),
  };
}

async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function iso(now: number) {
  return new Date(now).toISOString();
}
