import type { ClaimDeps, ClaimResult, VerifyInput } from "./claim";
import { consentRequired, createConsent } from "./claim-consent";
import {
  assertClaimMemberships,
  claimHashes,
  hashIdentifier,
  iso,
  resolveIdentity,
} from "./claim-identity";
import {
  assertSameResource,
  completedReservationResource,
  reconcileProviderConfirmation,
  tokenize,
} from "./claim-verify-support";
import { OAuthError } from "./oauth-errors";
import { invalidateMembershipCache } from "./membership-cache";

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
  const requestedResource = input.resource;
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
    const selectedResource = await completedReservationResource(
      deps,
      identityHashes,
      keyHash,
      requestedResource,
      nowIso,
    );
    return tokenize(deps, claimant, verifiedUserId, now, selectedResource);
  }
  if (
    existingReservation &&
    !existingReservation.completedAt &&
    existingReservation.expiresAt <= nowIso
  ) {
    await deps.repo.claim.releaseClaimReservation({ ...identityHashes, keyHash });
  } else if (existingReservation && !existingReservation.completedAt) {
    assertSameResource(requestedResource, existingReservation.selectedResource);
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
      const selectedResource = await completedReservationResource(
        deps,
        identityHashes,
        keyHash,
        requestedResource,
        nowIso,
      );
      return tokenize(deps, claimant, verifiedUserId, now, selectedResource);
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
  assertSameResource(requestedResource, verification.selectedResource);
  const selectedResource = verification.selectedResource as string;
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
    const winningReservation = await deps.repo.claim.getClaimReservation({
      ...identityHashes,
      keyHash,
    });
    if (winningReservation) {
      assertSameResource(requestedResource, winningReservation.selectedResource);
      if (winningReservation.completedAt && winningReservation.expiresAt > nowIso) {
        return tokenize(
          deps,
          claimant,
          verifiedUserId,
          now,
          winningReservation.selectedResource as string,
        );
      }
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
    await invalidateMembershipCache(deps.sessionStore, [claimant.userId, verifiedUserId]);
    const transferred = await deps.repo.claim.completeClaim(transfer);
    const completed =
      transferred ||
      (await deps.repo.claim.completedClaim({ ...identityHashes, keyHash, now: nowIso }));
    if (completed) {
      const persistedResource = await completedReservationResource(
        deps,
        identityHashes,
        keyHash,
        requestedResource,
        nowIso,
      );
      return tokenize(deps, claimant, verifiedUserId, now, persistedResource);
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
