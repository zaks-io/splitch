import { ErrorCodeSchema, type ErrorResponse } from "@splitch/sdk/control-plane";
import { remediationForServerError } from "./approval-stale-warn.js";
import { commandSupportsConfirm } from "./command-registry.js";
import { writeCliError } from "./errors.js";
import type { CliIo } from "./execute-types.js";
import { EXIT_API, EXIT_SELECTOR_AMBIGUOUS } from "./exit-codes.js";
import type { ParsedInvocation } from "./parse-args.js";

export function exitCodeForServerError(error: ErrorResponse): number {
  return error.code === "SELECTOR_AMBIGUOUS" ? EXIT_SELECTOR_AMBIGUOUS : EXIT_API;
}

export function writeServerError(
  io: CliIo,
  error: ErrorResponse,
  operationId: string,
  invocation?: ParsedInvocation,
): void {
  const parsedCode = ErrorCodeSchema.safeParse(error.code);
  if (!parsedCode.success) {
    writeCliError(io, {
      code: "CLI_SERVER_CODE_UNRECOGNIZED",
      causeSummary: `The server returned unrecognized error code "${String(error.code)}": ${error.message}`,
      remediation: "Update the CLI or report the server code before retrying the command",
    });
    return;
  }
  writeCliError(io, {
    code: parsedCode.data,
    causeSummary: error.message,
    remediation: remediationForServerError(error, commandSupportsConfirm(operationId), invocation),
    // Machine output keeps the complete refusal so callers can act without
    // scraping the human remediation.
    details: error.details,
  });
}
