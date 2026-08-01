import type { TokenBinding } from "./auth-binding.js";
import { withAuthorizationRetry } from "./auth.js";
import { type ResolvedContext, resolveContext, writeNearestConfig } from "./context.js";
import { SplitchCliError, writeCliError } from "./errors.js";
import { emit } from "./execute-io.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { createOperationSdks } from "./sdks.js";
import type { ParsedInvocation } from "./parse-args.js";

interface NamedResource {
  id: string;
  key?: string;
  slug?: string;
  name?: string;
}

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

async function callList(
  deps: CliDeps,
  operationId: string,
  input: Record<string, unknown>,
  binding?: TokenBinding,
): Promise<NamedResource[]> {
  const result = await withAuthorizationRetry(
    deps,
    async (authorization) => {
      const sdks = createOperationSdks(deps);
      const response = await sdks["control-plane-api"].callOperationById(operationId, input, {
        authorization,
      });
      return { status: response.ok ? 200 : response.status, value: response };
    },
    binding,
  );
  if (!result.ok) {
    throw new SplitchCliError({
      code: "CLI_SCOPE_UNRESOLVED",
      causeSummary: `${operationId} failed while resolving the selection: ${result.error.code}: ${result.error.message}`,
      remediation: "Fix the reported API failure and rerun splitch use",
    });
  }
  return (result.data as { items: NamedResource[] }).items;
}

/**
 * Mirrors the server's selector rule (membership-authority.ts): the globally
 * unique ID is matched across every reachable App first, and only then the
 * per-Org key, which is refused when it matches more than one App. Resolving
 * these differently here would send `use` and the token rebind to different
 * Apps, so the two passes must stay in lockstep.
 */
async function resolveAppSelector(deps: CliDeps, selector: string): Promise<NamedResource> {
  // No binding: `/orgs` is keyed by the principal, so whatever token is
  // already cached answers it, bound or not.
  const orgs = await callList(deps, "organizations_list", {});
  const reachable: NamedResource[] = [];
  for (const org of orgs) {
    reachable.push(
      ...(await callList(deps, "apps_list", { orgId: org.id }, { kind: "org", selector: org.id })),
    );
  }
  const byId = reachable.find((app) => app.id === selector);
  if (byId) return byId;
  const byKey = reachable.filter((app) => app.key === selector);
  if (byKey.length > 1) {
    throw new SplitchCliError({
      code: "CLI_SCOPE_UNRESOLVED",
      causeSummary: `App selector "${selector}" matches more than one App across your Organizations: ${byKey
        .map((app) => app.id)
        .join(", ")}`,
      remediation: "Pass the canonical App ID instead of the key",
    });
  }
  const [match] = byKey;
  if (match) return match;
  throw new SplitchCliError({
    code: "CLI_SCOPE_UNRESOLVED",
    causeSummary: `No App matching "${selector}" is reachable from your memberships. Reachable Apps: ${
      reachable.length
        ? reachable.map((app) => app.key ?? app.id).join(", ")
        : "(none — create one with splitch apps create <org-id> --name <name>)"
    }`,
    remediation: "Pass an existing App ID or key, or create the App first",
  });
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

async function resolveEnvironmentSelector(
  deps: CliDeps,
  appId: string,
  selector: string,
): Promise<NamedResource> {
  const environments = await callList(
    deps,
    "environments_list",
    { appId },
    { kind: "app", selector: appId },
  );
  const match =
    environments.find((environment) => environment.id === selector) ??
    environments.find((environment) => environment.key === selector);
  if (!match) {
    throw new SplitchCliError({
      code: "CLI_SCOPE_UNRESOLVED",
      causeSummary: `No Environment matching "${selector}" exists on App ${appId}. Available: ${environments
        .map((environment) => environment.key ?? environment.id)
        .join(", ")}`,
      remediation: "Pass one of the listed Environment keys or IDs",
    });
  }
  return match;
}
