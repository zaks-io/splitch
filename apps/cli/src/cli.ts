import { initCliObservability, shutdownCliObservability } from "@splitch/observability";
import { createFileCredentialStore } from "./credentials.js";
import { CLI_COMMANDS, findCommand, META_COMMANDS } from "./command-registry.js";
import { executeInvocation } from "./execute.js";
import { consoleIo } from "./execute-io.js";
import { EXIT_AUTH, EXIT_USAGE } from "./exit-codes.js";
import { normalizeCliError, writeCliError } from "./errors.js";
import type { ParsedInvocation } from "./parse-args.js";
import { longestMatchingCommandPath, parseInvocation } from "./parse-args.js";

const cliObservability = initCliObservability();

export interface RunCliOptions {
  readonly credentialPath?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
  readonly controlPlaneBaseUrl?: string;
  readonly evaluationBaseUrl?: string;
  readonly analysisBaseUrl?: string;
  readonly authBaseUrl?: string;
}

const COMMAND_LOOKUP_KEYS = new Set(CLI_COMMANDS.map((command) => command.path.join("\0")));

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<number> {
  if (args.length === 0) {
    writeCliError(consoleIo(), {
      code: "CLI_USAGE_INVALID",
      cause: "No command was provided",
      remediation: "Choose a command from the usage output",
    });
    printUsage();
    return EXIT_USAGE;
  }

  let invocation: ParsedInvocation;
  try {
    const parsed = parseInvocation(args);
    if (!parsed.metaCommand && parsed.commandPath.length > 0) {
      const matched = longestMatchingCommandPath(parsed.commandPath, COMMAND_LOOKUP_KEYS);
      const remainder = parsed.commandPath.slice(matched.length);
      invocation = {
        ...parsed,
        commandPath: matched,
        positionals: [...remainder, ...parsed.positionals],
      };
    } else {
      invocation = parsed;
    }
    if (
      !invocation.metaCommand &&
      invocation.commandPath.length > 0 &&
      !findCommand(invocation.commandPath)
    ) {
      writeCliError(consoleIo(), {
        code: "CLI_USAGE_INVALID",
        cause: `Unknown command ${invocation.commandPath.join(" ")}`,
        remediation: "Choose a command from the usage output",
      });
      printUsage();
      return EXIT_USAGE;
    }
  } catch (error) {
    writeCliError(consoleIo(), normalizeCliError(error));
    return EXIT_USAGE;
  }

  return executeParsedInvocation(invocation, options);
}

async function executeParsedInvocation(
  invocation: ParsedInvocation,
  options: RunCliOptions,
): Promise<number> {
  try {
    const result = await executeInvocation(invocation, {
      credentialStore: createFileCredentialStore(options.credentialPath),
      cwd: options.cwd,
      env: options.env,
      fetch: options.fetch,
      controlPlaneBaseUrl: options.controlPlaneBaseUrl,
      evaluationBaseUrl: options.evaluationBaseUrl,
      analysisBaseUrl: options.analysisBaseUrl,
      authBaseUrl: options.authBaseUrl,
    });
    return result.exitCode;
  } catch (error) {
    const cliError = normalizeCliError(error);
    writeCliError(consoleIo(), cliError);
    return cliError.code === "CLI_NOT_AUTHENTICATED" || cliError.code === "CLI_SESSION_EXPIRED"
      ? EXIT_AUTH
      : EXIT_USAGE;
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  splitch login | logout | use --app <id> [--env <id>] | context | health",
      "  splitch <resource> <action> [args] [--json] [--app <id>] [--env <id>]",
      "  splitch flags create --key <key> --variants on,off",
      "",
      `Meta commands: ${META_COMMANDS.join(", ")}`,
    ].join("\n"),
  );
}

export async function launchCli(): Promise<void> {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    cliObservability.captureException(error);
    writeCliError(consoleIo(), normalizeCliError(error));
    process.exitCode = 1;
  } finally {
    await shutdownCliObservability();
  }
}
