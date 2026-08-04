import { withAuthorizationRetry } from "./auth.js";
import type { TokenBinding } from "./auth-binding.js";
import type { CliCommandDefinition } from "./command-registry.js";
import type { ResolvedContext } from "./context.js";
import { SplitchCliError } from "./errors.js";
import type { CliDeps } from "./execute-types.js";
import { createOperationSdks } from "./sdks.js";

export interface NamedResource {
  id: string;
  key?: string;
  slug?: string;
  name?: string;
}

/**
 * Resolve `--app` / `--env` (and SPLITCH_APP / SPLITCH_ENV) selectors to
 * canonical IDs before a command issues a request. Config values are already
 * IDs from `splitch use`; only flag/env sources need this pass. Uses the same
 * ID-then-key rule as `use` so a slug never reaches the wire as a path segment.
 *
 * App selectors that already look like canonical IDs (`app_…`) pass through
 * without a list round-trip: App keys use the shared slug alphabet (no `_`),
 * so an `app_` prefix cannot be a key. Environment selectors always resolve —
 * Environment keys are unconstrained and could otherwise collide with `env_…`
 * ID shapes.
 */
export async function resolveContextSelectors(
  deps: CliDeps,
  context: ResolvedContext,
  command: Pick<CliCommandDefinition, "needsApp" | "needsEnvironment">,
): Promise<ResolvedContext> {
  let appId = context.appId;
  let environmentId = context.environmentId;

  if (command.needsApp && appId && isLiveSelector(context.appSource) && !looksLikeAppId(appId)) {
    appId = (await resolveAppSelector(deps, appId)).id;
  }

  if (command.needsEnvironment && environmentId && isLiveSelector(context.environmentSource)) {
    if (!appId) {
      throw new SplitchCliError({
        code: "CLI_SCOPE_UNRESOLVED",
        causeSummary: "An Environment cannot be resolved without an App",
        remediation: "Pass --app with the Environment, or run splitch use --app <app> first",
      });
    }
    environmentId = (await resolveEnvironmentSelector(deps, appId, environmentId)).id;
  }

  if (appId === context.appId && environmentId === context.environmentId) {
    return context;
  }
  return { ...context, appId, environmentId };
}

function isLiveSelector(source: ResolvedContext["appSource"]): boolean {
  return source === "flag" || source === "env";
}

function looksLikeAppId(selector: string): boolean {
  return selector.startsWith("app_");
}

/**
 * Mirrors the server's selector rule (membership-authority.ts): the globally
 * unique ID is matched across every reachable App first, and only then the
 * per-Org key, which is refused when it matches more than one App. Resolving
 * these differently here would send the CLI and the token rebind to different
 * Apps, so the two passes must stay in lockstep.
 */
export async function resolveAppSelector(deps: CliDeps, selector: string): Promise<NamedResource> {
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

export async function resolveEnvironmentSelector(
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
      causeSummary: `No Environment matching "${selector}" exists on App ${appId}. Available: ${
        environments.length
          ? environments.map((environment) => environment.key ?? environment.id).join(", ")
          : "(none)"
      }`,
      remediation: "Pass one of the listed Environment keys or IDs",
    });
  }
  return match;
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
      remediation: "Fix the reported API failure and retry the command",
    });
  }
  return (result.data as { items: NamedResource[] }).items;
}
