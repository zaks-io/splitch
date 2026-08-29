import type { CliCommandDefinition } from "./command-registry.js";
import { writeCliError } from "./errors.js";
import type { CliIo, CliResult } from "./execute-types.js";
import { EXIT_USAGE } from "./exit-codes.js";
import type { ParsedInvocation } from "./parse-args.js";

export function validateFlagReadUsage(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  io: CliIo,
): CliResult | null {
  if (!invocation.flags.summary) return null;
  if (command.operationId !== "flags_list" && command.operationId !== "flags_get") {
    return usageError(
      io,
      `--summary is not accepted by splitch ${command.path.join(" ")}`,
      `Drop --summary, or run splitch ${command.path.join(" ")} --help to list the accepted flags`,
    );
  }
  if (invocation.flags.json) {
    return usageError(
      io,
      "--summary cannot be combined with --json",
      "Drop --summary for the full hydrated JSON envelope, or drop --json for compact human output",
    );
  }
  if (command.operationId === "flags_get" && invocation.flags.env) {
    return usageError(
      io,
      "flags get --summary cannot be combined with --env",
      "Drop --summary to read the selected Environment's complete Flag Configuration",
    );
  }
  return null;
}

function usageError(io: CliIo, causeSummary: string, remediation: string): CliResult {
  writeCliError(io, { code: "CLI_USAGE_INVALID", causeSummary, remediation });
  return { exitCode: EXIT_USAGE };
}
