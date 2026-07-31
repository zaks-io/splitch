import { ErrorCodeSchema, type ErrorResponse, getRoute } from "@splitch/contracts";
import { createSplitchClient } from "@splitch/sdk";
import { withAuthorizationRetry } from "./auth.js";
import type { CliCommandDefinition } from "./command-registry.js";
import type { ResolvedContext } from "./context.js";
import { requireAppScope, requireEnvironmentScope } from "./context.js";
import { normalizeCliError, SplitchCliError, writeCliError } from "./errors.js";
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
    writeCliError(io, {
      code: "CLI_SCOPE_UNRESOLVED",
      cause: appScope.message,
      remediation: "Select an App with splitch use or pass --app",
    });
    return { exitCode: EXIT_SCOPE };
  }
  const envScope = requireEnvironmentScope(context, command.needsEnvironment);
  if (!envScope.ok) {
    writeCliError(io, {
      code: "CLI_SCOPE_UNRESOLVED",
      cause: envScope.message,
      remediation: "Select an Environment with splitch use or pass --env",
    });
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
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      cause: "flags verify requires a Flag ID",
      remediation: "Pass the Flag ID as the first positional argument",
    });
    return { exitCode: EXIT_USAGE };
  }
  if (!invocation.flags.targetingKey) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      cause: "flags verify requires --targeting-key",
      remediation: "Pass the Entity Targeting Key with --targeting-key",
    });
    return { exitCode: EXIT_USAGE };
  }

  try {
    const clientKeyResult = await withAuthorizationRetry(deps, async (authorization) => {
      const sdks = createOperationSdks(deps);
      const result = await sdks["control-plane-api"].callOperationById(
        "client_key_get",
        { appId: context.appId, environmentId: context.environmentId },
        { authorization },
      );
      return { status: result.ok ? 200 : result.status, value: result };
    });
    if (!clientKeyResult.ok) {
      emit(io, invocation.flags.json, clientKeyResult.error);
      writeServerError(io, clientKeyResult.error);
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
      // The CLI renders the returned ERROR details once in its fatal stderr contract.
      logger: { error: () => {}, debug: () => {} },
    });
    const verifyDetails = await client.verify(flagId, evaluationContext);
    emit(io, invocation.flags.json, verifyDetails);
    if (verifyDetails.reason === "ERROR") {
      writeCliError(io, {
        code: verifyDetails.errorCode ?? "SERVICE_UNAVAILABLE",
        cause: verifyDetails.errorMessage ?? "Flag verification failed",
        remediation: "Correct the reported data-plane failure and retry flags verify",
      });
      return { exitCode: EXIT_API, payload: verifyDetails };
    }
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
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      cause: "env-policy set requires --body-json",
      remediation: "Pass the Environment Policy JSON object with --body-json",
    });
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
        throw new SplitchCliError({
          code: "CLI_OPERATION_UNKNOWN",
          cause: `The operation ${operationId} is not registered`,
          remediation: "Use a command backed by a registered operation",
        });
      }
      const sdks = createOperationSdks(deps);
      const sdk = sdkForOwner(sdks, route.owner);
      const result = await sdk.callOperationById(operationId, input, { authorization });
      return { status: result.ok ? 200 : result.status, value: result };
    });
    if (!payload.ok) {
      emit(io, invocation.flags.json, payload.error);
      writeServerError(io, payload.error);
      return { exitCode: EXIT_API, payload: payload.error };
    }
    const projected = project ? project(payload.data) : payload.data;
    emit(io, invocation.flags.json, projected);
    return { exitCode: EXIT_OK, payload: projected };
  } catch (error) {
    return handleExecutionError(error, io);
  }
}

export function handleExecutionError(error: unknown, io: CliIo): CliResult {
  const cliError = normalizeCliError(error);
  writeCliError(io, cliError);
  if (cliError.code === "CLI_NOT_AUTHENTICATED" || cliError.code === "CLI_SESSION_EXPIRED") {
    return { exitCode: EXIT_AUTH };
  }
  return { exitCode: EXIT_USAGE };
}

function writeServerError(io: CliIo, error: ErrorResponse): void {
  const parsedCode = ErrorCodeSchema.safeParse(error.code);
  writeCliError(io, {
    code: parsedCode.success ? parsedCode.data : "INTERNAL_SERVER_ERROR",
    cause: error.message,
    remediation: "Correct the reported API failure and retry the command",
  });
}
