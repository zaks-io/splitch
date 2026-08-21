import { ensurePrincipalEmail } from "./auth-email-backfill.js";
import { refreshAccessToken } from "./auth-token.js";
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
    ...context,
    nextSteps: nextSteps(context),
  };
  emit(io, invocation.flags.json, payload);
  return { exitCode: EXIT_OK, payload };
}

type SessionVerification =
  | {
      readonly authenticated: true;
      readonly session: CliCredentialFile;
      readonly sessionUnverifiedReason?: "refresh_unreachable";
    }
  | { readonly authenticated: false };

/**
 * `context` is the only command that must answer "are you logged in" as data
 * instead of failing loud: every other command treats a dead refresh token as
 * a hard error (auth-token.ts throws `CLI_SESSION_EXPIRED`), which is correct
 * for them but was wrong here — it let a stale `credentialStore.load()` read
 * stand in for a live session (SPL-376). Reuse that same refresh-grant path,
 * no second session check, and only convert the one fault it already defines
 * as terminal. A transport failure (no response at all) proves nothing either
 * way, so it is never reported as a false `authenticated: false` (ADR-0036).
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
      return { authenticated: false };
    }
    if (error instanceof SplitchCliError) {
      throw error;
    }
    return { authenticated: true, session, sessionUnverifiedReason: "refresh_unreachable" };
  }
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
