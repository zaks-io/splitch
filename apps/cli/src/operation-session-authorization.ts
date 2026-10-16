import type { getRoute } from "@splitch/sdk/control-plane";
import { writeCliError } from "./errors.js";
import type { CliIo, CliResult } from "./execute-types.js";
import { EXIT_API } from "./exit-codes.js";
import {
  type CredentialOptions,
  selectedPersonalAccessToken,
} from "./personal-access-token-auth.js";

export function refuseSessionOnlyOperation(
  route: NonNullable<ReturnType<typeof getRoute>>,
  deps: CredentialOptions,
  io: CliIo,
): CliResult | null {
  if (route.permission !== "session-only" || selectedPersonalAccessToken(deps) === undefined)
    return null;
  writeCliError(io, {
    code: "FORBIDDEN",
    causeSummary: "This operation requires a login session and cannot use SPLITCH_TOKEN",
    remediation: "Unset SPLITCH_TOKEN and run splitch login before retrying the command",
    outcome: "user_action_required",
  });
  return { exitCode: EXIT_API };
}
