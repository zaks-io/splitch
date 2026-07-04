import { getRoute } from "@splitch/contracts";
import { createSplitchClient } from "@splitch/sdk";
import { withAuthorizationRetry } from "./auth.js";
import type { CliCommandDefinition } from "./command-registry.js";
import type { ResolvedContext } from "./context.js";
import { requireAppScope, requireEnvironmentScope } from "./context.js";
import { EXIT_API, EXIT_AUTH, EXIT_OK, EXIT_SCOPE, EXIT_USAGE } from "./exit-codes.js";
import { parseEvaluationContext } from "./operation-input.js";
import type { ParsedInvocation } from "./parse-args.js";
import { createOperationSdks, resolveDataPlaneBaseUrl, sdkForOwner } from "./sdks.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { emit } from "./execute-io.js";

export function validateCommandScope(
  command: CliCommandDefinition,
  context: ResolvedContext,
  io: CliIo,
): CliResult | null {
  const appScope = requireAppScope(context, command.needsApp);
  if (!appScope.ok) {
    io.error(appScope.message);
    return { exitCode: EXIT_SCOPE };
  }
  const envScope = requireEnvironmentScope(context, command.needsEnvironment);
  if (!envScope.ok) {
    io.error(envScope.message);
    return { exitCode: EXIT_SCOPE };
  }
  return null;
}

export async function executeFlagsVerify(
  _command: CliCommandDefinition,
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
  context: ResolvedContext,
): Promise<CliResult> {
  const flagId = invocation.positionals[0];
  if (!flagId) {
    io.error("splitch flags verify requires <flag_id>");
    return { exitCode: EXIT_USAGE };
  }
  if (!invocation.flags.targetingKey) {
    io.error("splitch flags verify requires --targeting-key");
    return { exitCode: EXIT_USAGE };
  }

  try {
    const clientKeyResult = await withAuthorizationRetry(deps, async (authorization) => {
      const sdks = createOperationSdks(deps);
      const result = await sdks["control-plane-api"].callOperation(
        "client_key_get",
        { appId: context.appId, environmentId: context.environmentId },
        { authorization },
      );
      return { status: result.ok ? 200 : result.status, value: result };
    });
    if (!clientKeyResult.ok) {
      emit(io, invocation.flags.json, clientKeyResult.error);
      return { exitCode: EXIT_API, payload: clientKeyResult.error };
    }
    const clientKey = clientKeyResult.data as { keyMaterial: string };
    const evaluationContext = parseEvaluationContext(
      invocation.flags.targetingKey,
      invocation.flags.contextJson,
    );
    const client = createSplitchClient({
      clientKey: clientKey.keyMaterial,
      endpoint: resolveDataPlaneBaseUrl(deps),
      fetch: deps.fetch,
    });
    const verifyDetails = await client.verify(flagId, evaluationContext);
    emit(io, invocation.flags.json, verifyDetails);
    return { exitCode: EXIT_OK, payload: verifyDetails };
  } catch (error) {
    return handleExecutionError(error, io);
  }
}

export async function executeEnvPolicyGet(
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
  context: ResolvedContext,
): Promise<CliResult> {
  return executeApiOperation(
    "environments_get",
    { appId: context.appId, environmentId: context.environmentId },
    invocation,
    deps,
    io,
    (data) => ({ policy: (data as { policy: unknown }).policy }),
  );
}

export async function executeEnvPolicySet(
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
  context: ResolvedContext,
): Promise<CliResult> {
  if (!invocation.flags.bodyJson) {
    io.error("splitch env-policy set requires --body-json");
    return { exitCode: EXIT_USAGE };
  }
  const policy = JSON.parse(invocation.flags.bodyJson) as unknown;
  return executeApiOperation(
    "environments_update",
    { appId: context.appId, environmentId: context.environmentId, policy },
    invocation,
    deps,
    io,
    (data) => ({ policy: (data as { policy: unknown }).policy }),
  );
}

export async function executeApiOperation(
  operationId: string,
  input: Record<string, unknown>,
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
  project?: (data: unknown) => unknown,
): Promise<CliResult> {
  try {
    const payload = await withAuthorizationRetry(deps, async (authorization) => {
      const route = getRoute(operationId);
      if (!route) {
        throw new Error(`splitch: unknown operation ${operationId}`);
      }
      const sdks = createOperationSdks(deps);
      const sdk = sdkForOwner(sdks, route.owner);
      const result = await sdk.callOperation(operationId, input, { authorization });
      return { status: result.ok ? 200 : result.status, value: result };
    });
    if (!payload.ok) {
      emit(io, invocation.flags.json, payload.error);
      return { exitCode: EXIT_API, payload: payload.error };
    }
    const projected = project ? project(payload.data) : payload.data;
    emit(io, invocation.flags.json, projected);
    return { exitCode: EXIT_OK, payload: projected };
  } catch (error) {
    return handleExecutionError(error, io);
  }
}

function handleExecutionError(error: unknown, io: CliIo): CliResult {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not logged in") || message.includes("session expired")) {
    io.error(message);
    return { exitCode: EXIT_AUTH };
  }
  io.error(message);
  return { exitCode: EXIT_USAGE };
}
