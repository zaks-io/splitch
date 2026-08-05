import { getRoute } from "@splitch/contracts";
import type { CliCommandDefinition } from "./command-registry.js";
import { findCommand } from "./command-registry.js";
import {
  assertPathParamsPresent,
  commandUsageLine,
  conflictingSuppliedPositional,
  excessPositionalError,
  missingPositionalError,
  missingRequiredPositional,
} from "./command-positionals.js";

import { type ResolvedContext, resolveContext } from "./context.js";
import { SplitchCliError, writeCliError } from "./errors.js";
import { consoleIo, emit } from "./execute-io.js";
import {
  executeApiOperation,
  executeEnvPolicyGet,
  executeEnvPolicySet,
  executeFlagsVerify,
  handleExecutionError,
  validateCommandScope,
  validateFlagsVerifyUsage,
} from "./execute-operations.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { CliInputError } from "./flag-create-input.js";
import { buildOperationInput } from "./operation-input.js";
import type { ParsedInvocation } from "./parse-args.js";
import { resolveContextSelectors, resolveFlagSelector } from "./scope-resolve.js";

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
      causeSummary: `Unknown command ${invocation.commandPath.join(" ")}`,
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
      const { resolveControlPlaneBaseUrl } = await import("./sdks.js");
      const endpoint = invocation.flags.endpoint ?? resolveControlPlaneBaseUrl(deps);
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
      // Cold start is the first-class path: no App exists yet, so none can be
      // required. A resolved App context still binds the session to it.
      const session = await loginWithDeviceFlow(deps, context.appId ?? null);
      const payload = {
        principal: session.principal,
        selectedAppId: session.selectedAppId,
        nextSteps: session.selectedAppId
          ? ["splitch use --app <app> --env dev", "splitch flags list"]
          : [
              "splitch orgs list",
              'splitch orgs create --name "<name>"',
              'splitch apps create <org-id> --name "<name>"',
              "splitch use --app <app> --env dev",
            ],
      };
      emit(io, invocation.flags.json, payload);
      if (!invocation.flags.json) {
        io.error(`Logged in as ${session.principal.userId}.`);
        io.error(`Next: ${payload.nextSteps.join(" | ")}`);
      }
      return { exitCode: EXIT_OK, payload };
    }
    case "logout": {
      const { logout } = await import("./auth.js");
      await logout(deps);
      emit(io, invocation.flags.json, { loggedOut: true });
      return { exitCode: EXIT_OK, payload: { loggedOut: true } };
    }
    case "use": {
      const { executeUse } = await import("./execute-use.js");
      return executeUse(invocation, deps, io);
    }
    case "context": {
      const { executeContext } = await import("./execute-context.js");
      return executeContext(invocation, deps, io);
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
  // Positionals before scope / SDK so misuse never reaches control-plane-sdk
  // path building (and never needs credentials to learn the argument is required).
  const positionalError = validateRequiredPositionals(command, invocation, io);
  if (positionalError) {
    return positionalError;
  }

  let context = await resolveContext({
    flags: { app: invocation.flags.app, env: invocation.flags.env },
    env: deps.env,
    cwd: deps.cwd,
  });

  const scopeError = validateCommandScope(command, context, io);
  if (scopeError) {
    return scopeError;
  }

  if (command.kind === "flags_verify") {
    const usageError = validateFlagsVerifyUsage(invocation, io);
    if (usageError) {
      return usageError;
    }
  }

  try {
    context = await resolveContextSelectors(deps, context, command);
  } catch (error) {
    return handleExecutionError(error, io);
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
    assertPathParamsPresent(command, input);
    input = await resolveFlagIdInInput(deps, command, context, input);
  } catch (error) {
    return handleInputError(error, invocation, io);
  }
  return executeApiOperation(command.operationId, input, invocation, deps, io);
}

function validateRequiredPositionals(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  io: CliIo,
): CliResult | null {
  try {
    const conflict = conflictingSuppliedPositional(command, invocation);
    if (conflict) {
      writeCliError(io, excessPositionalError(conflict));
      io.log(`Usage:\n  ${commandUsageLine(command)}`);
      return { exitCode: EXIT_USAGE };
    }
    const missing = missingRequiredPositional(command, invocation);
    if (!missing) {
      return null;
    }
    writeCliError(io, missingPositionalError(missing));
    io.log(`Usage:\n  ${commandUsageLine(command)}`);
    return { exitCode: EXIT_USAGE };
  } catch (error) {
    // Malformed --body-json throws from the gate's JSON parse.
    if (error instanceof SplitchCliError) {
      writeCliError(io, error);
      io.log(`Usage:\n  ${commandUsageLine(command)}`);
      return { exitCode: EXIT_USAGE };
    }
    throw error;
  }
}

/**
 * Commands whose route carries `:flagId` accept a Flag key as well as a
 * canonical ID. Resolve keys to IDs within the selected App before the request
 * hits the wire; leave body-only `flagId` fields (e.g. experiments create) untouched.
 */
async function resolveFlagIdInInput(
  deps: CliDeps,
  command: CliCommandDefinition,
  context: ResolvedContext,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const routePath = getRoute(command.operationId)?.path ?? "";
  if (!routePath.includes(":flagId")) {
    return input;
  }
  if (typeof input.flagId !== "string" || !input.flagId) {
    return input;
  }
  if (!context.appId) {
    return input;
  }
  const resolved = await resolveFlagSelector(deps, context.appId, input.flagId);
  if (resolved.id === input.flagId) {
    return input;
  }
  return { ...input, flagId: resolved.id };
}

function handleInputError(error: unknown, invocation: ParsedInvocation, io: CliIo): CliResult {
  if (error instanceof CliInputError) {
    emit(io, invocation.flags.json, error.payload);
    writeCliError(io, error);
    return { exitCode: EXIT_USAGE, payload: error.payload };
  }
  return handleExecutionError(error, io);
}
