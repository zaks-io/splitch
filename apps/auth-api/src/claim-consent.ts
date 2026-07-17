import type { ClaimDeps } from "./claim";
import { OAuthError } from "./oauth-errors";

export async function createConsent(
  deps: ClaimDeps,
  verificationId: string,
  existingUserId: string,
  now: number,
  hashIdentifier: (value: string) => Promise<string>,
): Promise<string> {
  const consentId = `ccons_${crypto.randomUUID()}`;
  await deps.repo.claim.createConsentAttempt({
    id: consentId,
    verificationId,
    existingUserHash: await hashIdentifier(existingUserId),
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
    now: new Date(now).toISOString(),
  });
  return consentId;
}

export function consentRequired(
  deps: ClaimDeps,
  consentId: string,
  verificationId: string,
  now: number,
): OAuthError {
  return new OAuthError("interaction_required", "the email owner must approve linking", {
    consent_url: `${deps.consentBaseUrl}/claim/consent/${consentId}`,
    consent_expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
    verification_id: verificationId,
  });
}
