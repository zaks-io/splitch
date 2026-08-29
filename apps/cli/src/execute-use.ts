import type { ErrorResponse } from "@splitch/sdk/control-plane";
import { withAuthorizationRetry } from "./auth.js";
import { type ResolvedContext, resolveContext, writeNearestConfig } from "./context.js";
import { SplitchCliError, writeCliError } from "./errors.js";
import { emit } from "./execute-io.js";
import { handleExecutionError } from "./execute-operations.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import type { ParsedInvocation } from "./parse-args.js";
import { createOperationSdks } from "./sdks.js";
import { exitCodeForServerError, writeServerError } from "./server-errors.js";

interface NamedResource {
  readonly id: string;
  readonly key?: string;
  readonly name?: string;
}

/**
 * `splitch use` resolves the selectors to canonical IDs against the live
 * control plane and writes THOSE to .splitch/config.json. Later commands can
 * use selectors directly, but validating here proves the App/Environment
 * exist while the user is still looking at the command that named them. The
 * canonical IDs also avoid selector reads on every later command.
 */
export async function executeUse(
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
): Promise<CliResult> {
  if (!invocation.flags.app && !invocation.flags.env) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      causeSummary: "splitch use requires an App or Environment selection",
      remediation: "Pass --app, --env, or both",
    });
    return { exitCode: EXIT_USAGE };
  }

  try {
    const current = await resolveContext({ flags: {}, env: deps.env, cwd: deps.cwd });
    const app = await resolveRequestedApp(deps, invocation, io);
    if (isCliResult(app)) return app;
    const environment = await resolveRequestedEnvironment(
      deps,
      invocation,
      io,
      invocation.flags.env,
      app?.id ?? current.appId,
    );
    if (isCliResult(environment)) return environment;
    return finishUse(invocation, deps, io, { current, app, environment });
  } catch (error) {
    return handleExecutionError(error, io);
  }
}

async function resolveRequestedApp(
  deps: CliDeps,
  invocation: ParsedInvocation,
  io: CliIo,
): Promise<NamedResource | CliResult | undefined> {
  const selector = invocation.flags.app;
  if (!selector) return undefined;
  const result = await lookupResource(deps, "apps_get", { appId: selector });
  return result.ok ? result.resource : serverRefusal(io, result.error, "apps_get", invocation);
}

async function finishUse(
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
  selection: {
    current: ResolvedContext;
    app: NamedResource | undefined;
    environment: NamedResource | undefined;
  },
): Promise<CliResult> {
  const { app, environment } = selection;
  const { path, clearedEnvironmentId } = await persistSelection(deps, selection);
  const payload = {
    path,
    ...(app ? { app: { id: app.id, key: app.key, name: app.name } } : {}),
    ...(environment
      ? { environment: { id: environment.id, key: environment.key, name: environment.name } }
      : {}),
    ...(clearedEnvironmentId ? { clearedEnvironmentId } : {}),
  };
  emit(io, invocation.flags.json, payload);
  if (!invocation.flags.json) {
    writeUseNotices(io, clearedEnvironmentId);
  }
  return { exitCode: EXIT_OK, payload };
}

function writeUseNotices(io: CliIo, clearedEnvironmentId: string | undefined): void {
  if (clearedEnvironmentId) {
    io.error(
      `Cleared the previous Environment selection (${clearedEnvironmentId}); it belonged to the old App. Select one with splitch use --env <env>.`,
    );
  }
  io.error("Next: splitch flags create --key <key> --variants on,off | splitch flags list");
}

/**
 * Switching to a DIFFERENT App without naming an Environment must not carry the
 * previous App's Environment ID into the new pairing: clear it and report it,
 * rather than persist a config that fails every later Environment-scoped
 * command. Re-selecting the App already in the config is not a switch, so the
 * Environment stays: agents re-run `splitch use --app <app>` idempotently, and
 * dropping a still-valid Environment there would break the next command.
 */
async function persistSelection(
  deps: CliDeps,
  selection: {
    current: ResolvedContext;
    app: NamedResource | undefined;
    environment: NamedResource | undefined;
  },
): Promise<{ path: string; clearedEnvironmentId?: string }> {
  const { current, app, environment } = selection;
  const switchedApp = app !== undefined && app.id !== current.appId;
  const staleEnvironmentId =
    switchedApp && environment === undefined ? current.environmentId : undefined;
  const path = await writeNearestConfig(deps.cwd ?? process.cwd(), {
    app: app?.id,
    environment: staleEnvironmentId ? null : environment?.id,
  });
  return { path, ...(staleEnvironmentId ? { clearedEnvironmentId: staleEnvironmentId } : {}) };
}

async function resolveRequestedEnvironment(
  deps: CliDeps,
  invocation: ParsedInvocation,
  io: CliIo,
  selector: string | undefined,
  appId: string | undefined,
): Promise<NamedResource | CliResult | undefined> {
  if (!selector) return undefined;
  if (!appId) {
    throw new SplitchCliError({
      code: "CLI_SCOPE_UNRESOLVED",
      causeSummary: "An Environment cannot be selected without an App",
      remediation: "Pass --app with the Environment, or run splitch use --app <app> first",
    });
  }
  const result = await lookupResource(deps, "environments_get", {
    appId,
    environmentId: selector,
  });
  return result.ok
    ? result.resource
    : serverRefusal(io, result.error, "environments_get", invocation);
}

function serverRefusal(
  io: CliIo,
  error: ErrorResponse,
  operationId: string,
  invocation: ParsedInvocation,
): CliResult {
  writeServerError(io, error, operationId, invocation);
  return { exitCode: exitCodeForServerError(error), payload: error };
}

function isCliResult(value: NamedResource | CliResult | undefined): value is CliResult {
  return value !== undefined && "exitCode" in value;
}

type LookupResult =
  | { readonly ok: true; readonly resource: NamedResource }
  | { readonly ok: false; readonly error: ErrorResponse };

async function lookupResource(
  deps: CliDeps,
  operationId: "apps_get" | "environments_get",
  input: Record<string, unknown>,
): Promise<LookupResult> {
  const result = await withAuthorizationRetry(
    deps,
    async (authorization) => {
      const response = await createOperationSdks(deps)["control-plane-api"].callOperationById(
        operationId,
        input,
        { authorization },
      );
      return { status: response.ok ? 200 : response.status, value: response };
    },
    typeof input.appId === "string" && input.appId
      ? { kind: "app", selector: input.appId }
      : undefined,
  );
  return result.ok
    ? { ok: true, resource: readNamedResource(result.data, operationId) }
    : { ok: false, error: result.error };
}

function readNamedResource(data: unknown, operationId: string): NamedResource {
  if (!data || typeof data !== "object" || !("id" in data) || typeof data.id !== "string") {
    throw new SplitchCliError({
      code: "CLI_UNEXPECTED_ERROR",
      causeSummary: `${operationId} returned a resource without an ID`,
      remediation: `Retry the command and report the ${operationId} response shape if it persists`,
    });
  }
  const resource = data as { id: string; key?: unknown; name?: unknown };
  return {
    id: resource.id,
    ...(typeof resource.key === "string" ? { key: resource.key } : {}),
    ...(typeof resource.name === "string" ? { name: resource.name } : {}),
  };
}
