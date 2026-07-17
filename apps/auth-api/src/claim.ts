import type { Repository } from "@splitch/db";
import { consentRequired, createConsent } from "./claim-consent";
import {
  assertClaimMemberships,
  claimHashes,
  hashIdentifier,
  iso,
  resolveIdentity,
  type Provisional,
} from "./claim-identity";
import { OAuthError } from "./oauth-errors";
import type { RateLimiter } from "./rate-limit";
import type { TokenSigner } from "./token-exchange";
import type { WorkOsPort } from "./workos";

const OTP_TTL_MS = 10 * 60 * 1000;
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
  otp?: string;
  verificationId?: string;
  idempotencyKey: string;
}

export interface ClaimResult {
  access_token: string;
  user_id: string;
  org_id: string;
  app_id: string;
}

export async function initiateClaim(
  deps: ClaimDeps,
  input: InitiateInput,
): Promise<{ otp_required: true; verification_id: string; user_id: string; org_id: string }> {
  const now = deps.now();
  deps.rateLimiter.assertUnderCeiling(input.remoteIp ?? "unknown", now);
  const claimant = await resolveIdentity(deps, input.identityAssertion, input.email, now);
  await assertClaimMemberships(deps, claimant);
  await assertStillProvisional(deps, claimant.orgId);
  const hashes = await claimHashes(claimant.userId, claimant.email);
  const verificationId = `cver_${crypto.randomUUID()}`;
  const existing = await deps.workos.findVerifiedUserByEmail(claimant.email);
  await deps.repo.claim.createVerification({
    ...hashes,
    id: verificationId,
    expiresAt: iso(now + OTP_TTL_MS),
    now: iso(now),
  });
  if (existing && existing !== claimant.userId) {
    const consentId = await createConsent(deps, verificationId, existing, now, hashIdentifier);
    throw consentRequired(deps, consentId, verificationId, now);
  }
  await deps.workos.sendEmailVerification(claimant.userId, claimant.email);
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
  const verifiedUserId = existing && existing !== claimant.userId ? existing : claimant.userId;
  const identityHashes = {
    ...hashes,
    organizationHash: await hashIdentifier(claimant.orgId),
    appHash: await hashIdentifier(claimant.appId),
    verifiedUserHash: await hashIdentifier(verifiedUserId),
  };
  if (await deps.repo.claim.completedClaim({ ...identityHashes, keyHash, now: nowIso })) {
    return tokenize(deps, claimant, verifiedUserId, now);
  }
  await assertClaimMemberships(deps, claimant);
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
  const collision = Boolean(existing && existing !== claimant.userId);
  const approvedConsent =
    collision && existingHash
      ? await deps.repo.claim.getApprovedConsent({
          verificationId: verification.id,
          existingUserHash: existingHash,
          now: nowIso,
        })
      : null;
  if (collision && !approvedConsent) {
    const consentId = await createConsent(
      deps,
      verification.id,
      existing as string,
      now,
      hashIdentifier,
    );
    throw consentRequired(deps, consentId, verification.id, now);
  }
  if (!verification.verifiedAt) {
    if (collision) {
      if (
        !(await deps.repo.claim.markVerifiedFromConsent({
          ...hashes,
          id: verification.id,
          consentAttemptId: approvedConsent as string,
          now: nowIso,
        }))
      ) {
        throw new OAuthError("server_error", "claim consent changed during confirmation");
      }
    } else {
      if (!input.otp) {
        throw new OAuthError("invalid_grant", "claim verification requires an OTP");
      }
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
  }
  const transfer = {
    ...identityHashes,
    verificationId: verification.id,
    consentAttemptId: approvedConsent,
    keyHash,
    provisionalUserId: claimant.userId,
    verifiedUserId,
    orgId: claimant.orgId,
    appId: claimant.appId,
    acquisitionToken: crypto.randomUUID(),
    now: nowIso,
    expiresAt: iso(now + IDEMPOTENCY_TTL_MS),
  };
  let applied = false;
  try {
    applied = await deps.repo.claim.completeClaim(transfer);
  } catch {
    if (await deps.repo.claim.completedClaim({ ...identityHashes, keyHash, now: nowIso })) {
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

export async function refuseClaimConsent(
  deps: ClaimDeps,
  consentAttemptId: string,
  workosUserId: string,
): Promise<void> {
  if (
    !(await deps.repo.claim.refuseConsent({
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
