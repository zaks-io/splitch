import { ensurePrincipalEmail } from "./auth-email-backfill.js";
import { type ResolvedContext, resolveContext } from "./context.js";
import { writeCliError } from "./errors.js";
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

  // Prefer a real email when refresh can backfill one. When the Worker cannot
  // supply it yet, proceed with `{ userId }` only — never invent `"unknown"`.
  const session = await ensurePrincipalEmail(deps);
  const payload = {
    authenticated: true,
    principal: session.principal.email
      ? { userId: session.principal.userId, email: session.principal.email }
      : { userId: session.principal.userId },
    ...context,
    nextSteps: nextSteps(context),
  };
  emit(io, invocation.flags.json, payload);
  return { exitCode: EXIT_OK, payload };
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
