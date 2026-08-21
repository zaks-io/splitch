import { describeOAuthFault, isSessionRefusal } from "./auth-binding.js";
import type { AuthDeps } from "./auth-token.js";
import { notAuthenticatedError, refreshAccessToken, refreshFaultOf } from "./auth-token.js";
import type { CliCredentialFile } from "./credentials.js";
import {
  isAccessTokenExpired,
  principalNeedsEmailBackfill,
  withEmailBackfillUnavailable,
} from "./credentials.js";
import { SplitchCliError } from "./errors.js";

/**
 * Why `context` needs this instead of a plain `CliCredentialFile`: the reason
 * a swallowed backfill fault could not confirm the session must still reach
 * the caller, the same way a failed direct refresh does (SPL-376).
 */
export type SessionUnverifiedReason = "refresh_unreachable" | "refresh_failed";

export interface EmailBackfillOutcome {
  readonly session: CliCredentialFile;
  readonly unverifiedReason?: SessionUnverifiedReason;
  readonly unverifiedDetail?: string;
}

/**
 * Best-effort: ensure the stored principal carries a real email when the auth
 * Worker can supply one. An ambiguous refresh failure or an email-less
 * response does NOT fail the command — the caller keeps a still-valid access
 * token, and the miss is remembered against that access-token lifetime so
 * later commands do not burn refresh-token rotations forever. The fault is
 * still carried back on the outcome (never dropped) so a caller that reports
 * session health, like `context`, can tell "confirmed live" from "unconfirmed".
 *
 * `CLI_EMAIL_UNVERIFIED` is permanent and actionable (ADR-0036): rethrow it
 * instead of marking a miss that would silence every authorized command.
 *
 * A refresh-grant refusal proven by `invalid_grant` also rethrows, even when
 * the current access token is not yet expired: that response means the
 * session itself is dead, not merely that email backfill failed, so every
 * caller (not just `context`) must fail loud instead of proceeding on a token
 * that is about to stop working (SPL-376).
 */
export async function ensurePrincipalEmail(deps: AuthDeps): Promise<EmailBackfillOutcome> {
  const stored = await deps.credentialStore.load();
  if (!stored) {
    throw notAuthenticatedError();
  }
  if (!principalNeedsEmailBackfill(stored)) {
    return { session: stored };
  }
  try {
    const next = await refreshAccessToken(deps, stored, null, false);
    if (next.principal.email) {
      return { session: next };
    }
    const marked = withEmailBackfillUnavailable(next);
    await deps.credentialStore.save(marked);
    return { session: marked };
  } catch (error) {
    if (error instanceof SplitchCliError && error.code === "CLI_EMAIL_UNVERIFIED") {
      throw error;
    }
    if (isAccessTokenExpired(stored.credential.accessTokenExpiresAt)) {
      throw error;
    }
    return swallowBackfillFault(deps, stored, error);
  }
}

/**
 * Only reached once the current access token is still live, so the command
 * itself is not blocked either way. A proven session refusal still rethrows
 * (see the function doc above); anything else is remembered as a miss and
 * reported back as an unverified reason instead of being silently dropped.
 */
async function swallowBackfillFault(
  deps: AuthDeps,
  stored: CliCredentialFile,
  error: unknown,
): Promise<EmailBackfillOutcome> {
  if (error instanceof SplitchCliError && error.code === "CLI_SESSION_EXPIRED") {
    const fault = refreshFaultOf(error);
    if (fault && isSessionRefusal(fault)) {
      throw error;
    }
    const session = await rememberBackfillMissWithoutClobber(deps, stored, error);
    return {
      session,
      unverifiedReason: "refresh_failed",
      unverifiedDetail: fault
        ? describeOAuthFault(fault)
        : "the auth service returned no OAuth fault detail",
    };
  }
  const session = await rememberBackfillMissWithoutClobber(deps, stored, error);
  return { session, unverifiedReason: "refresh_unreachable" };
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
