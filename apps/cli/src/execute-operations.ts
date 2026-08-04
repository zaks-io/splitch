import { ErrorCodeSchema, type ErrorResponse, getRoute } from "@splitch/contracts";
import { createSplitchClient } from "@splitch/sdk";
import { withAuthorizationRetry } from "./auth.js";
import type { TokenBinding } from "./auth-binding.js";
import type { CliCommandDefinition } from "./command-registry.js";
import type { ResolvedContext } from "./context.js";
import { requireAppScope, requireEnvironmentScope } from "./context.js";
import { normalizeCliError, SplitchCliError, writeCliError } from "./errors.js";
import { emit } from "./execute-io.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_API, EXIT_AUTH, EXIT_OK, EXIT_SCOPE, EXIT_USAGE } from "./exit-codes.js";
import { parseEvaluationContext } from "./operation-input.js";
import type { ParsedInvocation } from "./parse-args.js";
import { createOperationSdks, resolveDataPlaneBaseUrl, sdkForRoute } from "./sdks.js";

export function validateCommandScope(
  command: CliCommandDefinition,
  context: ResolvedContext,
  io: CliIo,
): CliResult | null {
  const appScope = requireAppScope(context, command.needsApp);
  if (!appScope.ok) {
    writeCliError(io, {
      code: "CLI_SCOPE_UNRESOLVED",
      causeSummary: appScope.message,
      remediation: "Select an App with splitch use or pass --app",
    });
    return { exitCode: EXIT_SCOPE };
  }
  const envScope = requireEnvironmentScope(context, command.needsEnvironment);
  if (!envScope.ok) {
    writeCliError(io, {
      code: "CLI_SCOPE_UNRESOLVED",
      causeSummary: envScope.message,
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
  const flagKey = invocation.positionals[0];
  if (!flagKey) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      causeSummary: "flags verify requires a Flag key",
      remediation: "Pass the Flag key as the first positional argument",
    });
    return { exitCode: EXIT_USAGE };
  }
  if (!invocation.flags.targetingKey) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      causeSummary: "flags verify requires --targeting-key",
      remediation: "Pass the Entity Targeting Key with --targeting-key",
    });
    return { exitCode: EXIT_USAGE };
  }

  try {
    let sdkVerifyError: string | undefined;
    const clientKeyResult = await withAuthorizationRetry(
      deps,
      async (authorization) => {
        const sdks = createOperationSdks(deps);
        const result = await sdks["control-plane-api"].callOperationById(
          "client_key_get",
          { appId: context.appId, environmentId: context.environmentId },
          { authorization },
        );
        return { status: result.ok ? 200 : result.status, value: result };
      },
      operationBinding({ appId: context.appId }),
    );
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
      logger: {
        error: (message) => {
          sdkVerifyError = message;
        },
        debug: () => {},
      },
    });
    const verifyDetails = await client.verify(flagKey, evaluationContext);
    emit(io, invocation.flags.json, verifyDetails);
    if (verifyDetails.reason === "ERROR") {
      // The CLI renders this SDK failure once with command-specific remediation.
      writeCliError(io, {
        code: verifyDetails.errorCode ?? "CLI_DATA_PLANE_ERROR_CODE_MISSING",
        causeSummary:
          verifyDetails.errorMessage ?? "The data plane returned ERROR without an explanation",
        remediation: "Correct the reported data-plane failure and retry flags verify",
      });
      return { exitCode: EXIT_API, payload: verifyDetails };
    }
    if (sdkVerifyError) {
      io.error(sdkVerifyError);
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
      causeSummary: "env-policy set requires --body-json",
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

/**
 * The token binding an operation needs, derived from the same identifiers its
 * route path carries: an App-scoped path needs an app-bound token, an
 * Org-scoped path an org-bound one, and everything else (orgs list/create —
 * the cold-start surface) runs on whatever session token exists.
 */
function operationBinding(input: Record<string, unknown>): TokenBinding | undefined {
  if (typeof input.appId === "string" && input.appId) {
    return { kind: "app", selector: input.appId };
  }
  if (typeof input.orgId === "string" && input.orgId) {
    return { kind: "org", selector: input.orgId };
  }
  return undefined;
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
    const payload = await withAuthorizationRetry(
      deps,
      async (authorization) => {
        const route = getRoute(operationId);
        if (!route) {
          throw new SplitchCliError({
            code: "CLI_OPERATION_UNKNOWN",
            causeSummary: `The operation ${operationId} is not registered`,
            remediation: "Use a command backed by a registered operation",
          });
        }
        const sdks = createOperationSdks(deps);
        const sdk = sdkForRoute(sdks, route);
        const result = await sdk.callOperationById(operationId, input, { authorization });
        return { status: result.ok ? 200 : result.status, value: result };
      },
      operationBinding(input),
    );
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
  if (
    cliError.code === "CLI_NOT_AUTHENTICATED" ||
    cliError.code === "CLI_SESSION_EXPIRED" ||
    cliError.code === "CLI_EMAIL_UNVERIFIED"
  ) {
    return { exitCode: EXIT_AUTH };
  }
  return { exitCode: EXIT_USAGE };
}

export function writeServerError(io: CliIo, error: ErrorResponse): void {
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
    remediation: "Correct the reported API failure and retry the command",
  });
}
