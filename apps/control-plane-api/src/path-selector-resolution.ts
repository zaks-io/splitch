import type { ErrorResponse } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import type {
  AuthenticatedInputResolverArgs,
  AuthenticatedInputResolution,
  AuthenticatedInputResolver,
  Principal,
} from "@splitch/worker-runtime";

const APP_ID_PREFIX = "app_";
const ENVIRONMENT_ID_PREFIX = "env_";
const FLAG_ID_PREFIX = "flag_";

/** Resolve human-readable path selectors inside the authenticated request. */
export function makePathSelectorResolver(repo: Repository): AuthenticatedInputResolver {
  return (args) => resolveControlPlanePathSelectors(repo, args);
}

export async function resolveControlPlanePathSelectors(
  repo: Repository,
  { contract, input, params, principal, request }: SelectorResolverArgs,
): Promise<AuthenticatedInputResolution> {
  const resolvedParams = { ...params };

  const rawPrincipal = bindResolvedApp(principal, canonicalAppId(params.appId));
  const rawAppError = appScopeError(rawPrincipal, canonicalAppId(params.appId));
  if (rawAppError) return { ok: false, error: rawAppError };

  const app = await resolveApp(repo, rawPrincipal, params.appId);
  if (!app.ok) return app;
  assignResolved(resolvedParams, "appId", app.appId);
  const resolvedPrincipal = bindResolvedApp(rawPrincipal, resolvedParams.appId);
  const resolvedAppError = appScopeError(resolvedPrincipal, resolvedParams.appId);
  if (resolvedAppError) return { ok: false, error: resolvedAppError };

  const environment = await resolveEnvironment(repo, resolvedParams.appId, params.environmentId);
  if (!environment.ok) return environment;
  assignResolved(resolvedParams, "environmentId", environment.environmentId);

  const target = await resolveEnvironment(repo, resolvedParams.appId, params.targetEnvironmentId);
  if (!target.ok) return target;
  assignResolved(resolvedParams, "targetEnvironmentId", target.environmentId);

  const flag = await resolveFlag(
    repo,
    resolvedParams.appId,
    params.flagId,
    flagLookupBy(contract.id, request),
  );
  if (!flag.ok) return flag;
  assignResolved(resolvedParams, "flagId", flag.flagId);

  return {
    ok: true,
    input: withResolvedParams(input, params, resolvedParams),
    params: resolvedParams,
    principal: resolvedPrincipal,
  };
}

type SelectorResolverArgs = Pick<
  AuthenticatedInputResolverArgs,
  "input" | "params" | "principal" | "request"
> & { contract: Pick<AuthenticatedInputResolverArgs["contract"], "id"> };

async function resolveApp(
  repo: Repository,
  principal: Principal,
  selector: string | undefined,
): Promise<{ ok: true; appId?: string } | { ok: false; error: ErrorResponse }> {
  if (selector === undefined || selector.startsWith(APP_ID_PREFIX)) return { ok: true };
  const candidates = (
    await repo.identity.findAppSelectorCandidatesForUser(principal.id, selector)
  ).filter((candidate) => hasAppScope(principal.scopes, candidate.appId));
  if (candidates.length === 0) return failure("APP_NOT_FOUND", "app not found");
  if (candidates.length > 1) {
    return {
      ok: false,
      error: {
        code: "SELECTOR_AMBIGUOUS",
        message: `App selector "${selector}" matches more than one App`,
        details: { candidates },
      },
    };
  }
  return { ok: true, appId: candidates[0]?.appId };
}

async function resolveEnvironment(
  repo: Repository,
  appId: string | undefined,
  selector: string | undefined,
): Promise<{ ok: true; environmentId?: string } | { ok: false; error: ErrorResponse }> {
  if (selector === undefined) return { ok: true };
  if (!appId?.startsWith(APP_ID_PREFIX)) return failure("APP_NOT_FOUND", "app not found");
  const scope = appScope(appId);
  if (
    selector.startsWith(ENVIRONMENT_ID_PREFIX) &&
    (await repo.identity.getEnvironment(scope, selector))
  ) {
    return { ok: true };
  }
  // Environment not-found uses APP_NOT_FOUND throughout the Control Plane because
  // the Environment is part of the App resource boundary, unlike an App-level Flag.
  const environment = await repo.identity.getEnvironmentByKey(scope, selector);
  return environment
    ? { ok: true, environmentId: environment.id }
    : failure("APP_NOT_FOUND", "app not found");
}

async function resolveFlag(
  repo: Repository,
  appId: string | undefined,
  selector: string | undefined,
  lookupBy: "auto" | "key",
): Promise<{ ok: true; flagId?: string } | { ok: false; error: ErrorResponse }> {
  if (selector === undefined) return { ok: true };
  if (lookupBy === "auto" && selector.startsWith(FLAG_ID_PREFIX)) return { ok: true };
  if (!appId?.startsWith(APP_ID_PREFIX)) return failure("APP_NOT_FOUND", "app not found");
  const flag = await repo.flags.getFlagByKey(appScope(appId), selector);
  return flag ? { ok: true, flagId: flag.id } : failure("FLAG_NOT_FOUND", "flag not found");
}

function bindResolvedApp(principal: Principal, appId: string | undefined): Principal {
  if (appId === undefined || principal.appId !== null || !hasAppScope(principal.scopes, appId)) {
    return principal;
  }
  return { ...principal, appId };
}

function hasAppScope(scopes: readonly string[], appId: string): boolean {
  return ["owner", "admin", "member"].some((role) => scopes.includes(`app:${appId}:${role}`));
}

function assignResolved(
  params: Record<string, string>,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined) params[name] = value;
}

function appScopeError(principal: Principal, appId: string | undefined): ErrorResponse | null {
  if (appId === undefined || principal.appId === appId) return null;
  return { code: "FORBIDDEN", message: "credential is not scoped to this app", details: {} };
}

function canonicalAppId(selector: string | undefined): string | undefined {
  return selector?.startsWith(APP_ID_PREFIX) ? selector : undefined;
}

function flagLookupBy(contractId: string, request: Request): "auto" | "key" {
  return contractId === "flags_get" && new URL(request.url).searchParams.get("by") === "key"
    ? "key"
    : "auto";
}

function withResolvedParams(
  input: unknown,
  rawParams: Record<string, string>,
  resolvedParams: Record<string, string>,
): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("path selector resolver received non-object parsed input");
  }
  if (Object.keys(rawParams).length === 0) return input;
  const parsedParams = "params" in input ? input.params : undefined;
  if (!parsedParams || typeof parsedParams !== "object" || Array.isArray(parsedParams)) {
    throw new Error("path selector resolver received parsed input without object params");
  }
  const replacements = Object.fromEntries(
    Object.entries(resolvedParams).filter(([name, value]) => rawParams[name] !== value),
  );
  if (Object.keys(replacements).length === 0) return input;
  return { ...input, params: { ...parsedParams, ...replacements } };
}

function failure(
  code: "APP_NOT_FOUND" | "FLAG_NOT_FOUND",
  message: string,
): { ok: false; error: ErrorResponse } {
  return { ok: false, error: { code, message, details: {} } };
}
