import type { Repository } from "@splitch/db";
import { consentRequired, createConsent } from "./claim-consent";
import {
  assertClaimMemberships,
  claimHashes,
  hashIdentifier,
  iso,
  resolveIdentity,
} from "./claim-identity";
import { verifyClaim } from "./claim-verify";
import { OAuthError } from "./oauth-errors";
import type { RateLimiter } from "./rate-limit";
import type { TokenSigner } from "./token-exchange";
import type { WorkOsPort } from "./workos";

export { verifyClaim };

const CLAIM_CEREMONY_TTL_MS = 15 * 60 * 1000;

export interface ClaimDeps {
  repo: Repository;
  workos: WorkOsPort;
  tokenSigner: TokenSigner;
  rateLimiter: RateLimiter;
  consentBaseUrl: string;
  defaultResource: string;
  now: () => number;
  /** Legacy local fixture seams; hosted claims never use them. */
  otp?: unknown;
  idempotency?: unknown;
}

export interface InitiateInput {
  identityAssertion: string;
  email: string;
  remoteIp: string | undefined;
  resource?: string;
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
    selectedResource: input.resource ?? deps.defaultResource,
    expiresAt: iso(now + CLAIM_CEREMONY_TTL_MS),
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
