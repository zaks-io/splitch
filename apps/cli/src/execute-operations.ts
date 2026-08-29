import { createSplitchClient } from "@splitch/sdk";
import { getRoute } from "@splitch/sdk/control-plane";
import { warnStaleApprovalDiscard } from "./approval-stale-warn.js";
import { withAuthorizationRetry } from "./auth.js";
import {
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  type TokenAuthorization,
  type TokenBinding,
} from "./auth-binding.js";
import { missingPositionalError } from "./command-positionals.js";
import type { CliCommandDefinition } from "./command-registry.js";
import type { ResolvedContext } from "./context.js";
import { requireAppScope, requireEnvironmentScope } from "./context.js";
import {
  cliErrorCodeForVerifyDetails,
  normalizeCliError,
  SplitchCliError,
  writeCliError,
} from "./errors.js";
import { emit } from "./execute-io.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_API, EXIT_AUTH, EXIT_OK, EXIT_SCOPE, EXIT_USAGE } from "./exit-codes.js";
import { environmentSelectorOverride, parseEvaluationContext } from "./operation-input.js";
import { emitOperationNotices } from "./operation-notices.js";
import type { ParsedInvocation } from "./parse-args.js";
import { createOperationSdks, resolveDataPlaneBaseUrl, sdkForRoute } from "./sdks.js";
import { exitCodeForServerError, writeServerError } from "./server-errors.js";

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
  const usageError = validateFlagsVerifyUsage(invocation, io);
  if (usageError) {
    return usageError;
  }

  // Argv-only Flag key — `--body-json` is not a source (matches the positional gate).
  // Check before the Client Key fetch so a missing key never exits mute after I/O.
  const flagKey = invocation.positionals[0];
  if (!flagKey) {
    writeCliError(io, missingPositionalError("flag-key"));
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
          {
            appId: context.appId,
            environmentId: context.environmentId,
            ...environmentSelectorOverride(invocation.flags.by),
          },
          { authorization },
        );
        return { status: result.ok ? 200 : result.status, value: result };
      },
      operationBinding({ appId: context.appId }),
    );
    if (!clientKeyResult.ok) {
      emit(io, invocation.flags.json, clientKeyResult.error);
      writeServerError(io, clientKeyResult.error, "client_key_get", invocation);
      return {
        exitCode: exitCodeForServerError(clientKeyResult.error),
        payload: clientKeyResult.error,
      };
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
        code: cliErrorCodeForVerifyDetails(verifyDetails.errorCode),
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

export function validateFlagsVerifyUsage(
  invocation: ParsedInvocation,
  io: CliIo,
): CliResult | null {
  // Flag-key positional is validated earlier via requiredPositionals (SPL-306).
  if (!invocation.flags.targetingKey) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      causeSummary: "flags verify requires --targeting-key",
      remediation: "Pass the Entity Targeting Key with --targeting-key",
    });
    return { exitCode: EXIT_USAGE };
  }
  return null;
}

/**
 * The token binding an operation needs, derived from the same identifiers its
 * route path carries: an App-scoped path needs an app-bound token, an
 * Org-scoped path an org-bound one. Scope-free reads use membership-wide
 * authority; scope-free mutations retain the session's selector-bound token.
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
  project?: (data: unknown) => unknown | Promise<unknown>,
): Promise<CliResult> {
  try {
    const route = requireOperationRoute(operationId);
    const tokenAuthorization = operationAuthorization(route, input);
    const payload = await withAuthorizationRetry(
      deps,
      async (authorization) => {
        const sdks = createOperationSdks(deps);
        const sdk = sdkForRoute(sdks, route);
        const result = await sdk.callOperationById(operationId, input, { authorization });
        return { status: result.ok ? 200 : result.status, value: result };
      },
      tokenAuthorization,
    );
    if (!payload.ok) {
      // `writeServerError` owns both channels: the enriched JSON on stdout and
      // the prose on stderr. Emitting `payload.error` here too would put the
      // raw wire shape and the enriched one on the same stream.
      writeServerError(io, payload.error, operationId, invocation);
      return { exitCode: exitCodeForServerError(payload.error), payload: payload.error };
    }
    const projected = project ? await project(payload.data) : payload.data;
    emit(io, invocation.flags.json, projected);
    // Keyed off payload shape, not operationId: any command that returns an
    // Approval Request (or list) must surface a recorded stale discard.
    warnStaleApprovalDiscard(io, projected);
    emitOperationNotices(operationId, projected, invocation.flags.json, io);
    if (operationId === "apps_delete") {
      // Local session cleanup must not turn a successful delete into a non-zero exit.
      try {
        await clearScopeAfterAppDelete(deps, input, projected);
      } catch (cleanupError) {
        const message =
          cleanupError instanceof Error ? cleanupError.message : "unknown cleanup failure";
        io.error(`Warning: App deleted, but local session cleanup failed: ${message}`);
        io.error("Run `splitch use` to pick another App if your session still points at it.");
      }
    }
    return { exitCode: EXIT_OK, payload: projected };
  } catch (error) {
    return handleExecutionError(error, io);
  }
}

function requireOperationRoute(operationId: string): NonNullable<ReturnType<typeof getRoute>> {
  const route = getRoute(operationId);
  if (route) return route;
  throw new SplitchCliError({
    code: "CLI_OPERATION_UNKNOWN",
    causeSummary: `The operation ${operationId} is not registered`,
    remediation: "Use a command backed by a registered operation",
  });
}

/**
 * Path selectors bind to their App or Organization. Selector-free Control
 * Plane reads use the wide marker only for cached-token reuse; refresh mints
 * the session default. SPL-530 adds the wide request; mutations keep existing authority.
 */
export function operationAuthorization(
  route: NonNullable<ReturnType<typeof getRoute>>,
  input: Record<string, unknown>,
): TokenAuthorization | undefined {
  const selectorBinding = operationBinding(input);
  if (selectorBinding) return selectorBinding;
  return route.method === "GET" && route.auth === "control-plane-token"
    ? { kind: MEMBERSHIP_WIDE_READ_AUTHORIZATION }
    : undefined;
}

async function clearScopeAfterAppDelete(
  deps: CliDeps,
  input: Record<string, unknown>,
  payload: unknown,
): Promise<void> {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("deleted" in payload) ||
    (payload as { deleted: unknown }).deleted !== true
  ) {
    return;
  }
  const appId = typeof input.appId === "string" ? input.appId : undefined;
  if (!appId) return;
  const { clearDeletedAppFromConfig } = await import("./context.js");
  await clearDeletedAppFromConfig(deps.cwd ?? process.cwd(), appId);
  const stored = await deps.credentialStore.load();
  if (stored?.credential.selectedAppId !== appId) return;
  const { selectedAppId: _removed, ...credentialRest } = stored.credential;
  await deps.credentialStore.save({
    ...stored,
    credential: {
      ...credentialRest,
      accessTokenBinding:
        stored.credential.accessTokenBinding === `app:${appId}`
          ? ""
          : stored.credential.accessTokenBinding,
    },
  });
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
  if (cliError.code === "CLI_SCOPE_UNRESOLVED" || cliError.code === "CLI_TOKEN_BINDING_REFUSED") {
    return { exitCode: EXIT_SCOPE };
  }
  return { exitCode: EXIT_USAGE };
}
