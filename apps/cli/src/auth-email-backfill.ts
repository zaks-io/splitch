import type { AuthDeps } from "./auth-token.js";
import { notAuthenticatedError, refreshAccessToken } from "./auth-token.js";
import type { CliCredentialFile } from "./credentials.js";
import {
  isAccessTokenExpired,
  principalNeedsEmailBackfill,
  withEmailBackfillUnavailable,
} from "./credentials.js";

/**
 * Best-effort: ensure the stored principal carries a real email when the auth
 * Worker can supply one. Refresh failure or an email-less response does NOT
 * fail the command — the caller keeps a still-valid access token, and the miss
 * is remembered so later commands do not burn refresh-token rotations forever.
 */
export async function ensurePrincipalEmail(deps: AuthDeps): Promise<CliCredentialFile> {
  const stored = await deps.credentialStore.load();
  if (!stored) {
    throw notAuthenticatedError();
  }
  if (!principalNeedsEmailBackfill(stored)) {
    return stored;
  }
  try {
    const next = await refreshAccessToken(deps, stored, null, false);
    if (next.principal.email) {
      return next;
    }
    const marked = withEmailBackfillUnavailable(next);
    await deps.credentialStore.save(marked);
    return marked;
  } catch (error) {
    if (!isAccessTokenExpired(stored.credential.accessTokenExpiresAt)) {
      const marked = withEmailBackfillUnavailable(stored);
      await deps.credentialStore.save(marked);
      return marked;
    }
    throw error;
  }
}
