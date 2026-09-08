import { parseBodyJsonRecord } from "./command-positionals.js";
import type { CliCommandDefinition } from "./command-registry.js";
import { writeCliError } from "./errors.js";
import type { CliIo, CliResult } from "./execute-types.js";
import { validateFlagsVerifyUsage } from "./execute-operations.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { validateFlagTargetingRulesAddUsage } from "./flag-targeting-rules-add-input.js";
import { advertisedLongFlags, type HelpFlag } from "./help-flags.js";
import { oneTimeSecretDescriptor, oneTimeSecretOutputPathError } from "./one-time-secret-output.js";
import type { ParsedInvocation } from "./parse-args.js";

export function validateAdvertisedFlags(
  invocation: ParsedInvocation,
  helpFlags: readonly HelpFlag[],
  io: CliIo,
): CliResult | null {
  const accepted = advertisedLongFlags(helpFlags);
  const supplied = invocation.rawArgs.filter((arg) => arg.startsWith("--"));
  const unsupported = supplied.find((arg) => !accepted.has(arg));
  if (!unsupported) return null;
  const path = invocation.metaCommand ?? invocation.commandPath.join(" ");
  writeCliError(io, {
    code: "CLI_USAGE_INVALID",
    causeSummary: `${unsupported} is not accepted by splitch ${path}`,
    remediation: `Drop ${unsupported}, or run splitch ${path} --help to list the accepted flags`,
  });
  return { exitCode: EXIT_USAGE };
}

export function validateSpecializedUsage(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  io: CliIo,
): CliResult | null {
  const body = parseBodyJsonRecord(invocation.flags.bodyJson);
  return (
    validateApprovalUsage(command, invocation, body, io) ??
    validateOneTimeSecretUsage(command, invocation, body, io) ??
    validateCommandSpecificUsage(command, invocation, io)
  );
}

function validateApprovalUsage(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  body: Record<string, unknown> | undefined,
  io: CliIo,
): CliResult | null {
  if (
    command.supportsConfirm &&
    body &&
    Object.hasOwn(body, "review") &&
    !invocation.flags.confirm
  ) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      causeSummary: `review in --body-json requires --confirm for splitch ${command.path.join(" ")}`,
      remediation: "Add --confirm to explicitly approve and apply the Policy-gated change",
    });
    return { exitCode: EXIT_USAGE };
  }
  if (!invocation.flags.confirm || command.supportsConfirm) return null;
  writeCliError(io, {
    code: "CLI_USAGE_INVALID",
    causeSummary: `--confirm is not accepted by splitch ${command.path.join(" ")}`,
    remediation: `Drop --confirm, or run splitch ${command.path.join(" ")} --help to list the accepted flags`,
  });
  return { exitCode: EXIT_USAGE };
}

function validateOneTimeSecretUsage(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  body: Record<string, unknown> | undefined,
  io: CliIo,
): CliResult | null {
  const descriptor = oneTimeSecretDescriptor(command.operationId);
  if (!descriptor) {
    if (!invocation.flags.outputFile) return null;
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      causeSummary: `--output-file is not accepted by splitch ${command.path.join(" ")}`,
      remediation: `Drop --output-file, or run splitch ${command.path.join(" ")} --help to list the accepted flags`,
    });
    return { exitCode: EXIT_USAGE };
  }
  if (!invocation.flags.outputFile) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      causeSummary: `--output-file is required by splitch ${command.path.join(" ")}`,
      remediation: "Pass a new path for the once-only secret",
    });
    return { exitCode: EXIT_USAGE };
  }
  const pathError = oneTimeSecretOutputPathError(invocation.flags.outputFile);
  if (pathError) {
    writeCliError(io, pathError);
    return { exitCode: EXIT_USAGE };
  }
  if (descriptor.secretField !== "webhookSecret" || !Object.hasOwn(body ?? {}, "webhookSecret")) {
    return null;
  }
  writeCliError(io, {
    code: "CLI_USAGE_INVALID",
    causeSummary: "webhookSecret is not accepted in CLI --body-json",
    remediation: "Remove webhookSecret and let Splitch mint it into --output-file",
  });
  return { exitCode: EXIT_USAGE };
}

function validateCommandSpecificUsage(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  io: CliIo,
): CliResult | null {
  if (command.kind === "flags_verify") return validateFlagsVerifyUsage(invocation, io);
  if (command.kind === "flag_targeting_rules_add") {
    return validateFlagTargetingRulesAddUsage(invocation, io);
  }
  return null;
}
