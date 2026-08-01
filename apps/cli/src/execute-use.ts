import type { TokenBinding } from "./auth-binding.js";
import { withAuthorizationRetry } from "./auth.js";
import { resolveContext, writeNearestConfig } from "./context.js";
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

  const path = await writeNearestConfig(deps.cwd ?? process.cwd(), {
    app: app?.id,
    environment: environment?.id,
  });
  const payload = {
    path,
    ...(app ? { app: { id: app.id, key: app.key, name: app.name } } : {}),
    ...(environment
      ? { environment: { id: environment.id, key: environment.key, name: environment.name } }
      : {}),
  };
  emit(io, invocation.flags.json, payload);
  if (!invocation.flags.json) {
    io.error("Next: splitch flags create --key <key> --variants on,off | splitch flags list");
  }
  return { exitCode: EXIT_OK, payload };
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

async function resolveAppSelector(deps: CliDeps, selector: string): Promise<NamedResource> {
  const orgs = await callList(deps, "organizations_list", {});
  const seen: string[] = [];
  for (const org of orgs) {
    const apps = await callList(
      deps,
      "apps_list",
      { orgId: org.id },
      { kind: "org", selector: org.id },
    );
    const match =
      apps.find((app) => app.id === selector) ?? apps.find((app) => app.key === selector);
    if (match) {
      return match;
    }
    seen.push(...apps.map((app) => app.key ?? app.id));
  }
  throw new SplitchCliError({
    code: "CLI_SCOPE_UNRESOLVED",
    causeSummary: `No App matching "${selector}" is reachable from your memberships. Reachable Apps: ${
      seen.length
        ? seen.join(", ")
        : "(none — create one with splitch apps create <org-id> --name <name>)"
    }`,
    remediation: "Pass an existing App ID or slug, or create the App first",
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
