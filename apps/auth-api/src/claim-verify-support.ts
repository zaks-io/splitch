import { rememberMemberProfile } from "@splitch/contracts";
import type { ClaimDeps, ClaimResult } from "./claim";
import { type claimHashes, iso, type Provisional } from "./claim-identity";
import { OAuthError } from "./oauth-errors";

const COMPLETED_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

export type ClaimIdentityHashes = Awaited<ReturnType<typeof claimHashes>> & {
  organizationHash: string;
  appHash: string;
  verifiedUserHash: string;
};

export async function reconcileProviderConfirmation(
  deps: ClaimDeps,
  claimant: Provisional,
  identityHashes: ClaimIdentityHashes,
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
    verification.expiresAt <= nowIso
  ) {
    return false;
  }
  assertSameResource(reservation.selectedResource as string, verification.selectedResource);
  if (
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

export async function tokenize(
  deps: ClaimDeps,
  claimant: Provisional,
  userId: string,
  now: number,
  audience: string,
): Promise<ClaimResult> {
  await rememberMemberProfile(deps.sessionStore, userId, claimant.email);
  return {
    access_token: await deps.tokenSigner.mintAccessToken(
      userId,
      [`app:${claimant.appId}:owner`],
      "anonymous",
      Math.floor(now / 1000),
      audience,
    ),
    user_id: userId,
    org_id: claimant.orgId,
    app_id: claimant.appId,
  };
}

export function assertSameResource(requested: string | undefined, selected: string | null): void {
  if (selected === null) {
    throw new OAuthError("invalid_grant", "claim verification has no persisted resource authority");
  }
  if (requested !== undefined && requested !== selected) {
    throw new OAuthError("invalid_request", "claim resource does not match the initiated ceremony");
  }
}

export async function completedReservationResource(
  deps: ClaimDeps,
  identityHashes: ClaimIdentityHashes,
  keyHash: string,
  requestedResource: string | undefined,
  nowIso: string,
): Promise<string> {
  const reservation = await deps.repo.claim.getClaimReservation({ ...identityHashes, keyHash });
  if (!reservation?.completedAt || reservation.expiresAt <= nowIso) {
    throw new OAuthError("invalid_grant", "completed claim reservation is unavailable");
  }
  assertSameResource(requestedResource, reservation.selectedResource);
  return reservation.selectedResource as string;
}
