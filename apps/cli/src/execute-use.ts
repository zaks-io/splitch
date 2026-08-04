import { type ResolvedContext, resolveContext, writeNearestConfig } from "./context.js";
import { SplitchCliError, writeCliError } from "./errors.js";
import { emit } from "./execute-io.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import type { ParsedInvocation } from "./parse-args.js";
import {
  type NamedResource,
  resolveAppSelector,
  resolveEnvironmentSelector,
} from "./scope-resolve.js";

/**
 * `splitch use` resolves the selectors to canonical IDs against the live
 * control plane and writes THOSE to .splitch/config.json. Route paths
 * co-scope on canonical IDs, so persisting a raw slug would make every later
 * command fail FORBIDDEN; resolving here also proves the App/Environment
 * exist while the user is still looking at the command that named them.
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

  const current = await resolveContext({ flags: {}, env: deps.env, cwd: deps.cwd });
  const app = invocation.flags.app
    ? await resolveAppSelector(deps, invocation.flags.app)
    : undefined;
  const environment = await resolveRequestedEnvironment(
    deps,
    invocation.flags.env,
    app?.id ?? current.appId,
  );

  const { path, clearedEnvironmentId } = await persistSelection(deps, {
    current,
    app,
    environment,
  });
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
    if (clearedEnvironmentId) {
      io.error(
        `Cleared the previous Environment selection (${clearedEnvironmentId}); it belonged to the old App. Select one with splitch use --env <env>.`,
      );
    }
    io.error("Next: splitch flags create --key <key> --variants on,off | splitch flags list");
  }
  return { exitCode: EXIT_OK, payload };
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
  selector: string | undefined,
  appId: string | undefined,
): Promise<NamedResource | undefined> {
  if (!selector) return undefined;
  if (!appId) {
    throw new SplitchCliError({
      code: "CLI_SCOPE_UNRESOLVED",
      causeSummary: "An Environment cannot be selected without an App",
      remediation: "Pass --app with the Environment, or run splitch use --app <app> first",
    });
  }
  return resolveEnvironmentSelector(deps, appId, selector);
}
