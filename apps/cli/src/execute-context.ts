import { describeOAuthFault, isSessionRefusal } from "./auth-binding.js";
import { ensurePrincipalEmail } from "./auth-email-backfill.js";
import { refreshAccessToken, refreshFaultOf } from "./auth-token.js";
import { type ResolvedContext, resolveContext } from "./context.js";
import {
  type CliCredentialFile,
  emailUnavailableReason,
  isAccessTokenExpired,
} from "./credentials.js";
import { SplitchCliError, writeCliError } from "./errors.js";
import { emit } from "./execute-io.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_AUTH, EXIT_OK } from "./exit-codes.js";
import type { ParsedInvocation } from "./parse-args.js";

/**
 * `splitch context` is the first command an agent runs, so it is the one place
 * where an empty answer is most expensive: printing `{}` at exit 0 reads as
 * "resolved, nothing to do" when the truth is "you are not logged in". Every
 * other command fails loud on a missing session; this one now does too, and
 * reports the session alongside the scope so a single call answers "who am I
 * and what am I pointed at".
 */
export async function executeContext(
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
): Promise<CliResult> {
  const context = await resolveContext({
    flags: { app: invocation.flags.app, env: invocation.flags.env },
    env: deps.env,
    cwd: deps.cwd,
  });
  const stored = await deps.credentialStore.load();
  if (!stored) {
    writeCliError(io, {
      code: "CLI_NOT_AUTHENTICATED",
      causeSummary: "No CLI login session is available",
      remediation: "Run splitch login before retrying the command",
    });
    return { exitCode: EXIT_AUTH };
  }

  const verified = await verifySession(deps, stored);
  if (!verified.authenticated) {
    const payload = {
      authenticated: false,
      ...context,
      nextSteps: ["splitch login"],
    };
    emit(io, invocation.flags.json, payload);
    return { exitCode: EXIT_OK, payload };
  }

  // Prefer a real email when refresh can backfill one. When the Worker cannot
  // supply it yet, proceed with `{ userId }` plus a reason — never invent
  // `"unknown"`. Permanent unverified-email faults fail loud (ADR-0036).
  const session = verified.session;
  const reason = emailUnavailableReason(session);
  const payload = {
    authenticated: true,
    principal: session.principal.email
      ? { userId: session.principal.userId, email: session.principal.email }
      : {
          userId: session.principal.userId,
          ...(reason ? { emailUnavailableReason: reason } : {}),
        },
    ...(verified.sessionUnverifiedReason
      ? { sessionUnverifiedReason: verified.sessionUnverifiedReason }
      : {}),
    ...(verified.sessionUnverifiedDetail
      ? { sessionUnverifiedDetail: verified.sessionUnverifiedDetail }
      : {}),
    ...context,
    nextSteps: nextSteps(context),
  };
  emit(io, invocation.flags.json, payload);
  return { exitCode: EXIT_OK, payload };
}

type SessionUnverifiedReason = "refresh_unreachable" | "refresh_failed";

type SessionVerification =
  | {
      readonly authenticated: true;
      readonly session: CliCredentialFile;
      readonly sessionUnverifiedReason?: SessionUnverifiedReason;
      readonly sessionUnverifiedDetail?: string;
    }
  | { readonly authenticated: false };

/**
 * `context` is the only command that must answer "are you logged in" as data
 * instead of failing loud: every other command treats a dead refresh token as
 * a hard error (auth-token.ts throws `CLI_SESSION_EXPIRED`), which is correct
 * for them but was wrong here — it let a stale `credentialStore.load()` read
 * stand in for a live session (SPL-376). Reuse that same refresh-grant path,
 * no second session check, and only convert the one fault it already defines
 * as terminal.
 *
 * `CLI_SESSION_EXPIRED` is not by itself proof of that: `mintFailureError`
 * (auth-token.ts) also raises it for a reachable auth service returning an
 * ambiguous fault (a 5xx, a body with no OAuth `error` at all, or a code that
 * isn't `invalid_grant`) — a transient outage looks identical to a dead
 * session at that call site. Only `invalid_grant` proves the auth service
 * looked at the refresh token and refused it; anything else, plus a transport
 * failure that never got a response, proves nothing either way, so it is
 * never reported as a false `authenticated: false` (ADR-0036).
 */
async function verifySession(
  deps: CliDeps,
  stored: CliCredentialFile,
): Promise<SessionVerification> {
  let session = stored;
  try {
    session = await ensurePrincipalEmail(deps);
    if (isAccessTokenExpired(session.credential.accessTokenExpiresAt)) {
      // ensurePrincipalEmail only refreshes to backfill a missing email; a
      // session that already has one short-circuits without ever touching
      // the refresh grant, so an expired access token still needs its own check.
      session = await refreshAccessToken(deps, session, null, false);
    }
    return { authenticated: true, session };
  } catch (error) {
    if (error instanceof SplitchCliError && error.code === "CLI_SESSION_EXPIRED") {
      return classifySessionExpiredFault(error, session);
    }
    if (error instanceof SplitchCliError) {
      throw error;
    }
    return { authenticated: true, session, sessionUnverifiedReason: "refresh_unreachable" };
  }
}

/**
 * Split out of `verifySession` to keep the branching readable: a
 * `CLI_SESSION_EXPIRED` error is only a proven refusal when its OAuth fault
 * says `invalid_grant`; anything else is unverified, with the fault detail
 * carried so a caller can tell the cases apart (SPL-376).
 */
function classifySessionExpiredFault(
  error: SplitchCliError,
  session: CliCredentialFile,
): SessionVerification {
  const fault = refreshFaultOf(error);
  if (fault && isSessionRefusal(fault)) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    session,
    sessionUnverifiedReason: "refresh_failed",
    sessionUnverifiedDetail: fault
      ? describeOAuthFault(fault)
      : "the auth service returned no OAuth fault detail",
  };
}

function nextSteps(context: ResolvedContext): string[] {
  if (!context.appId) {
    return [
      "splitch orgs list",
      'splitch orgs create --name "<name>"',
      'splitch apps create <org-id> --name "<name>"',
      "splitch use --app <app> --env dev",
    ];
  }
  if (!context.environmentId) {
    return ["splitch use --env dev"];
  }
  return ["splitch flags list"];
}
