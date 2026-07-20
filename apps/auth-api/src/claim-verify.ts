import type { ClaimDeps, ClaimResult, VerifyInput } from "./claim";
import { consentRequired, createConsent } from "./claim-consent";
import {
  assertClaimMemberships,
  claimHashes,
  hashIdentifier,
  iso,
  type Provisional,
  resolveIdentity,
} from "./claim-identity";
import { OAuthError } from "./oauth-errors";

const IN_FLIGHT_LEASE_MS = 5 * 60 * 1000;
const COMPLETED_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity lint/complexity/noExcessiveLinesPerFunction: the ordered security gates are deliberately kept in one auditable ceremony.
export async function verifyClaim(deps: ClaimDeps, input: VerifyInput): Promise<ClaimResult> {
  const now = deps.now();
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
  const existingReservation = await deps.repo.claim.getClaimReservation({
    ...identityHashes,
    keyHash,
  });
  if (existingReservation?.completedAt && existingReservation.expiresAt > nowIso) {
    assertSameResource(input.resource, existingReservation.selectedResource);
    return tokenize(deps, claimant, verifiedUserId, now, existingReservation.selectedResource);
  }
  if (
    existingReservation &&
    !existingReservation.completedAt &&
    existingReservation.expiresAt <= nowIso
  ) {
    await deps.repo.claim.releaseClaimReservation({ ...identityHashes, keyHash });
  } else if (existingReservation && !existingReservation.completedAt) {
    const reconciled = await reconcileProviderConfirmation(
      deps,
      claimant,
      identityHashes,
      keyHash,
      existingReservation,
      verifiedUserId,
      nowIso,
    );
    if (reconciled) {
      assertSameResource(input.resource, existingReservation.selectedResource);
      return tokenize(deps, claimant, verifiedUserId, now, existingReservation.selectedResource);
    }
    throw new OAuthError("invalid_request", "a claim with this idempotency_key is in progress");
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
  assertSameResource(input.resource, verification.selectedResource);
  const selectedResource = verification.selectedResource ?? input.resource ?? null;
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
    deps.rateLimiter.assertUnderCeiling(input.remoteIp ?? "unknown", now);
    const consentId = await createConsent(
      deps,
      verification.id,
      existing as string,
      now,
      hashIdentifier,
    );
    throw consentRequired(deps, consentId, verification.id, now);
  }
  const reservation = {
    ...identityHashes,
    keyHash,
    verificationId: verification.id,
    selectedResource,
    expiresAt: iso(now + IN_FLIGHT_LEASE_MS),
  };
  // Reserve before WorkOS consumes the one-use OTP. A same-key loser therefore
  // observes the durable reservation, never a provider-specific OTP failure.
  if (!(await deps.repo.claim.reserveClaim(reservation))) {
    if (await deps.repo.claim.completedClaim({ ...identityHashes, keyHash, now: nowIso })) {
      return tokenize(deps, claimant, verifiedUserId, now, selectedResource);
    }
    throw new OAuthError("invalid_request", "a claim with this idempotency_key is in progress");
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
    acquisitionKeyHash: keyHash,
    replayExpiresAt: iso(now + COMPLETED_REPLAY_TTL_MS),
    now: nowIso,
  };
  let providerConfirmationStarted = false;
  let providerConfirmationRejected = false;
  try {
    deps.rateLimiter.assertUnderCeiling(input.remoteIp ?? "unknown", now);
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
        if (
          !(await deps.repo.claim.markProviderConfirmationStarted({
            ...identityHashes,
            keyHash,
            now: nowIso,
          }))
        ) {
          throw new OAuthError("server_error", "claim confirmation changed during verification");
        }
        providerConfirmationStarted = true;
        try {
          await deps.workos.confirmEmailVerification(claimant.userId, claimant.email, input.otp);
        } catch {
          if (!(await deps.workos.isEmailVerified(claimant.userId, claimant.email))) {
            providerConfirmationRejected = true;
            throw new OAuthError("invalid_grant", "WorkOS rejected the email verification code");
          }
        }
        if (
          !(await deps.repo.claim.markVerified({ ...hashes, id: verification.id, now: nowIso }))
        ) {
          throw new OAuthError("server_error", "claim verification changed during confirmation");
        }
      }
    }
    if (await deps.repo.claim.completeClaim(transfer)) {
      return tokenize(deps, claimant, verifiedUserId, now, selectedResource);
    }
    if (await deps.repo.claim.completedClaim({ ...identityHashes, keyHash, now: nowIso })) {
      return tokenize(deps, claimant, verifiedUserId, now, selectedResource);
    }
    // A failed acquisition guard is terminal for this claim attempt. It is
    // different from a provider call whose result may have been interrupted,
    // so do not leave the reservation blocking a fresh attempt.
    await deps.repo.claim.releaseClaimReservation(reservation);
    throw new OAuthError("invalid_grant", "claim state changed during transfer");
  } catch (cause) {
    if (!providerConfirmationStarted || providerConfirmationRejected) {
      await deps.repo.claim.releaseClaimReservation(reservation);
    }
    throw cause;
  }
}

async function reconcileProviderConfirmation(
  deps: ClaimDeps,
  claimant: Provisional,
  identityHashes: Awaited<ReturnType<typeof claimHashes>> & {
    organizationHash: string;
    appHash: string;
    verifiedUserHash: string;
  },
  keyHash: string,
  reservation: {
    verificationId: string;
    selectedResource: string | null;
    completedAt: string | null;
    providerConfirmationStartedAt: string | null;
  },
  verifiedUserId: string,
  nowIso: string,
): Promise<boolean> {
  if (!reservation.providerConfirmationStartedAt) return false;
  if (!(await deps.workos.isEmailVerified(claimant.userId, claimant.email))) return false;
  const verification = await deps.repo.claim.getVerification(reservation.verificationId);
  if (
    !verification ||
    verification.provisionalUserHash !== identityHashes.provisionalUserHash ||
    verification.emailHash !== identityHashes.emailHash ||
    verification.consumedAt ||
    verification.expiresAt <= nowIso ||
    !(await deps.repo.claim.markVerified({ ...identityHashes, id: verification.id, now: nowIso }))
  ) {
    return false;
  }
  const transfer = {
    ...identityHashes,
    verificationId: verification.id,
    consentAttemptId: null,
    keyHash,
    provisionalUserId: claimant.userId,
    verifiedUserId,
    orgId: claimant.orgId,
    appId: claimant.appId,
    acquisitionToken: crypto.randomUUID(),
    acquisitionKeyHash: keyHash,
    replayExpiresAt: iso(Date.parse(nowIso) + COMPLETED_REPLAY_TTL_MS),
    now: nowIso,
  };
  if (await deps.repo.claim.completeClaim(transfer)) return true;
  return deps.repo.claim.completedClaim({ ...identityHashes, keyHash, now: nowIso });
}

async function tokenize(
  deps: ClaimDeps,
  claimant: Provisional,
  userId: string,
  now: number,
  audience?: string | null,
): Promise<ClaimResult> {
  return {
    access_token: await deps.tokenSigner.mintAccessToken(
      userId,
      [`app:${claimant.appId}:owner`],
      "anonymous",
      Math.floor(now / 1000),
      audience ?? undefined,
    ),
    user_id: userId,
    org_id: claimant.orgId,
    app_id: claimant.appId,
  };
}

function assertSameResource(requested: string | undefined, selected: string | null): void {
  if (requested !== undefined && selected !== null && requested !== selected) {
    throw new OAuthError("invalid_request", "claim resource does not match the initiated ceremony");
  }
}
