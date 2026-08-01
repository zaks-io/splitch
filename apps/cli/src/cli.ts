import { createRequire } from "node:module";
import { initCliObservability, shutdownCliObservability } from "@splitch/observability";
import { createFileCredentialStore } from "./credentials.js";
import { CLI_COMMANDS, findCommand } from "./command-registry.js";
import { executeInvocation } from "./execute.js";
import { consoleIo } from "./execute-io.js";
import { EXIT_AUTH, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { renderHelp, renderRootHelp } from "./help.js";
import { normalizeCliError, writeCliError } from "./errors.js";
import type { ParsedInvocation } from "./parse-args.js";
import { longestMatchingCommandPath, parseInvocation } from "./parse-args.js";

const cliObservability = initCliObservability();

export interface RunCliOptions {
  readonly credentialPath?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
  readonly platformTarget?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly evaluationBaseUrl?: string;
  readonly authBaseUrl?: string;
}

// The published binary receives no programmatic options; the environment
// selects the platform target and overrides individual API origins.
function withEnvOrigins(options: RunCliOptions): RunCliOptions {
  const env = options.env ?? process.env;
  return {
    ...options,
    platformTarget: options.platformTarget ?? env.SPLITCH_PLATFORM_TARGET,
    controlPlaneBaseUrl: options.controlPlaneBaseUrl ?? env.CONTROL_PLANE_API_ORIGIN,
    evaluationBaseUrl: options.evaluationBaseUrl ?? env.EVALUATION_API_ORIGIN,
    authBaseUrl: options.authBaseUrl ?? env.AUTH_API_ORIGIN,
  };
}

const COMMAND_LOOKUP_KEYS = new Set(CLI_COMMANDS.map((command) => command.path.join("\0")));

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  runOptions: RunCliOptions = {},
): Promise<number> {
  const options = withEnvOrigins(runOptions);
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(cliVersion());
    return EXIT_OK;
  }
  const help = renderHelp(args);
  if (help) {
    console.log(help);
    return EXIT_OK;
  }
  if (args.length === 0) {
    writeCliError(consoleIo(), {
      code: "CLI_USAGE_INVALID",
      causeSummary: "No command was provided",
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
        causeSummary: `Unknown command ${invocation.commandPath.join(" ")}`,
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
      platformTarget: options.platformTarget,
      controlPlaneBaseUrl: options.controlPlaneBaseUrl,
      evaluationBaseUrl: options.evaluationBaseUrl,
      authBaseUrl: options.authBaseUrl,
    });
    return result.exitCode;
  } catch (error) {
    cliObservability.captureException(error);
    const cliError = normalizeCliError(error);
    writeCliError(consoleIo(), cliError);
    return cliError.code === "CLI_NOT_AUTHENTICATED" || cliError.code === "CLI_SESSION_EXPIRED"
      ? EXIT_AUTH
      : EXIT_USAGE;
  }
}

function printUsage(): void {
  console.log(renderRootHelp());
}

function cliVersion(): string {
  // The published package ships dist/cli.js beside package.json; the same
  // relative shape holds in the repo. createRequire keeps this a runtime
  // lookup so the bundler cannot inline a stale value.
  const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
  if (!pkg.version) {
    throw new Error("package.json next to the CLI bundle has no version");
  }
  return pkg.version;
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
