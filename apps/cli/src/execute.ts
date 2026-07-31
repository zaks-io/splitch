import type { CliCommandDefinition } from "./command-registry.js";
import { findCommand } from "./command-registry.js";
import { resolveContext, writeNearestConfig } from "./context.js";
import { consoleIo, emit } from "./execute-io.js";
import {
  executeApiOperation,
  executeEnvPolicyGet,
  executeEnvPolicySet,
  executeFlagsVerify,
  handleExecutionError,
  validateCommandScope,
} from "./execute-operations.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { CliInputError } from "./flag-create-input.js";
import { writeCliError } from "./errors.js";
import { buildOperationInput } from "./operation-input.js";
import type { ParsedInvocation } from "./parse-args.js";

export type { CliDeps, CliResult } from "./execute-types.js";

export async function executeInvocation(
  invocation: ParsedInvocation,
  deps: CliDeps,
): Promise<CliResult> {
  const io = deps.io ?? consoleIo();
  if (invocation.metaCommand) {
    return executeMeta(invocation, deps, io);
  }
  const command = findCommand(invocation.commandPath);
  if (!command) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      cause: `Unknown command ${invocation.commandPath.join(" ")}`,
      remediation: "Run splitch without arguments to view the supported command paths",
    });
    return { exitCode: EXIT_USAGE };
  }
  return executeCommand(command, invocation, deps, io);
}

async function executeMeta(
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
): Promise<CliResult> {
  switch (invocation.metaCommand) {
    case "health": {
      const endpoint = invocation.flags.endpoint ?? "http://localhost:8787";
      const { createControlPlaneSdk } = await import("@splitch/control-plane-sdk");
      const health = await createControlPlaneSdk({ baseUrl: endpoint, fetch: deps.fetch }).health();
      emit(io, invocation.flags.json, health);
      return { exitCode: EXIT_OK, payload: health };
    }
    case "login": {
      const { loginWithDeviceFlow } = await import("./auth.js");
      const context = await resolveContext({
        flags: { app: invocation.flags.app, env: invocation.flags.env },
        env: deps.env,
        cwd: deps.cwd,
      });
      if (!context.appId) {
        writeCliError(io, {
          code: "CLI_SCOPE_UNRESOLVED",
          cause: "Login requires a selected App",
          remediation: "Pass --app with an App ID or slug, or set SPLITCH_APP",
        });
        return { exitCode: EXIT_USAGE };
      }
      const session = await loginWithDeviceFlow(deps, context.appId);
      const payload = { principal: session.principal };
      emit(io, invocation.flags.json, payload);
      return { exitCode: EXIT_OK, payload };
    }
    case "logout": {
      const { logout } = await import("./auth.js");
      await logout(deps);
      emit(io, invocation.flags.json, { loggedOut: true });
      return { exitCode: EXIT_OK, payload: { loggedOut: true } };
    }
    case "use": {
      if (!invocation.flags.app && !invocation.flags.env) {
        writeCliError(io, {
          code: "CLI_USAGE_INVALID",
          cause: "splitch use requires an App or Environment selection",
          remediation: "Pass --app, --env, or both",
        });
        return { exitCode: EXIT_USAGE };
      }
      const path = await writeNearestConfig(deps.cwd ?? process.cwd(), {
        app: invocation.flags.app,
        environment: invocation.flags.env,
      });
      const payload = { path, app: invocation.flags.app, environment: invocation.flags.env };
      emit(io, invocation.flags.json, payload);
      return { exitCode: EXIT_OK, payload };
    }
    case "context": {
      const context = await resolveContext({
        flags: { app: invocation.flags.app, env: invocation.flags.env },
        env: deps.env,
        cwd: deps.cwd,
      });
      emit(io, invocation.flags.json, context);
      return { exitCode: EXIT_OK, payload: context };
    }
    default:
      return { exitCode: EXIT_USAGE };
  }
}

async function executeCommand(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
): Promise<CliResult> {
  const context = await resolveContext({
    flags: { app: invocation.flags.app, env: invocation.flags.env },
    env: deps.env,
    cwd: deps.cwd,
  });

  const scopeError = validateCommandScope(command, context, io);
  if (scopeError) {
    return scopeError;
  }

  if (command.kind === "flags_verify") {
    return executeFlagsVerify(command, invocation, deps, io, context);
  }
  if (command.kind === "env_policy_get") {
    return executeEnvPolicyGet(invocation, deps, io, context);
  }
  if (command.kind === "env_policy_set") {
    return executeEnvPolicySet(invocation, deps, io, context);
  }

  let input: Record<string, unknown>;
  try {
    input = buildOperationInput(command, invocation, context);
  } catch (error) {
    return handleInputError(error, invocation, io);
  }
  return executeApiOperation(command.operationId, input, invocation, deps, io);
}

function handleInputError(error: unknown, invocation: ParsedInvocation, io: CliIo): CliResult {
  if (error instanceof CliInputError) {
    emit(io, invocation.flags.json, error.payload);
    writeCliError(io, error);
    return { exitCode: EXIT_USAGE, payload: error.payload };
  }
  return handleExecutionError(error, io);
}
