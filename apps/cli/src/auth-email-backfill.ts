import type { AuthDeps } from "./auth-token.js";
import { notAuthenticatedError, refreshAccessToken } from "./auth-token.js";
import type { CliCredentialFile } from "./credentials.js";
import {
  isAccessTokenExpired,
  principalNeedsEmailBackfill,
  withEmailBackfillUnavailable,
} from "./credentials.js";
import { SplitchCliError } from "./errors.js";

/**
 * Best-effort: ensure the stored principal carries a real email when the auth
 * Worker can supply one. A transient refresh failure or an email-less response
 * does NOT fail the command — the caller keeps a still-valid access token, and
 * the miss is remembered against that access-token lifetime so later commands
 * do not burn refresh-token rotations forever.
 *
 * `CLI_EMAIL_UNVERIFIED` is permanent and actionable (ADR-0036): rethrow it
 * instead of marking a miss that would silence every authorized command.
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
    if (error instanceof SplitchCliError && error.code === "CLI_EMAIL_UNVERIFIED") {
      throw error;
    }
    if (!isAccessTokenExpired(stored.credential.accessTokenExpiresAt)) {
      return rememberBackfillMissWithoutClobber(deps, stored, error);
    }
    throw error;
  }
}

/**
 * Persist the miss marker onto the CURRENT on-disk file only when its refresh
 * token still matches the pre-refresh snapshot. Writing `stored` after the
 * network round-trip would clobber a concurrent process that rotated R1→R2.
 */
async function rememberBackfillMissWithoutClobber(
  deps: AuthDeps,
  attempted: CliCredentialFile,
  error: unknown,
): Promise<CliCredentialFile> {
  const current = await deps.credentialStore.load();
  if (!current || current.principal.userId !== attempted.principal.userId) {
    throw error;
  }
  if (current.credential.refreshToken !== attempted.credential.refreshToken) {
    // Concurrent mint already landed R2; return it without rewriting R1.
    return current;
  }
  const marked = withEmailBackfillUnavailable(current);
  await deps.credentialStore.save(marked);
  return marked;
}
