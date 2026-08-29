import { type ErrorResponse, MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import {
  type AuthenticatedInputResolution,
  type AuthenticatedInputResolver,
  type AuthenticatedInputResolverArgs,
  appAccessCovers,
  type Principal,
} from "@splitch/worker-runtime";
import { membershipClaimsInScopes } from "./scope-binding";

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

  const forceEnvironmentId = canonicalEnvironmentLookup(request);
  const environment = await resolveEnvironment(
    repo,
    resolvedParams.appId,
    params.environmentId,
    forceEnvironmentId,
  );
  if (!environment.ok) return environment;
  assignResolved(resolvedParams, "environmentId", environment.environmentId);

  const target = await resolveEnvironment(
    repo,
    resolvedParams.appId,
    params.targetEnvironmentId,
    forceEnvironmentId,
  );
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
  // `findAppSelectorCandidatesForUser` already restricts the read to the caller's
  // live memberships. The extra filter narrows a selector-bound token to the Apps
  // its signed scopes actually name; a membership-wide token holds no App scopes,
  // so it is covered by its memberships instead.
  const candidates = (
    await repo.identity.findAppSelectorCandidatesForUser(principal.id, selector)
  ).filter((candidate) =>
    principal.authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION
      ? appAccessCovers(principal, candidate.appId)
      : hasAppScope(principal.scopes, candidate.appId),
  );
  if (candidates.length === 0) return failure("APP_NOT_FOUND", "app not found");
  if (candidates.length > 1) {
    return {
      ok: false,
      error: {
        code: "SELECTOR_AMBIGUOUS",
        message: `App selector "${selector}" matches more than one App`,
        details: { candidates, recommendedAction: "USE_CANONICAL_ID" },
      },
    };
  }
  return { ok: true, appId: candidates[0]?.appId };
}

async function resolveEnvironment(
  repo: Repository,
  appId: string | undefined,
  selector: string | undefined,
  forceCanonicalId: boolean,
): Promise<{ ok: true; environmentId?: string } | { ok: false; error: ErrorResponse }> {
  if (selector === undefined) return { ok: true };
  if (!appId?.startsWith(APP_ID_PREFIX)) return failure("APP_NOT_FOUND", "app not found");
  if (forceCanonicalId && selector.startsWith(ENVIRONMENT_ID_PREFIX)) return { ok: true };
  // Legacy keys can have the same `env_` shape as canonical IDs. One scoped OR
  // query is required to detect that collision without silently choosing a
  // plausible wrong Environment; it also avoids the old two-read ID-miss path.
  // The default canonical-ID path still costs this resolver read plus the
  // handler's read of the same row. SPL-541 accepts that cost so collision
  // detection remains unconditional.
  const candidates = await repo.identity.findEnvironmentSelectorCandidates(
    appScope(appId),
    selector,
  );
  if (candidates.length === 0 && selector.startsWith(ENVIRONMENT_ID_PREFIX)) {
    return { ok: true };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: {
        code: "SELECTOR_AMBIGUOUS",
        message: `Environment selector "${selector}" matches more than one Environment`,
        details: { candidates, recommendedAction: "USE_CANONICAL_ID" },
      },
    };
  }
  // Environment not-found uses APP_NOT_FOUND throughout the Control Plane because
  // the Environment is part of the App resource boundary, unlike an App-level Flag.
  const environment = candidates[0];
  return environment
    ? {
        ok: true,
        ...(environment.environmentId === selector
          ? {}
          : { environmentId: environment.environmentId }),
      }
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
  return membershipClaimsInScopes(scopes).some(
    (claim) => claim.axis === "app" && claim.id === appId,
  );
}

function assignResolved(
  params: Record<string, string>,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined) params[name] = value;
}

// A membership-wide read token is App-unbound by design and carries its authority
// in its live `memberships` set, so `principal.appId` is the wrong question to
// ask it. `appAccessCovers` is the same predicate the registrar's scope step
// uses; asking it here keeps one answer to "may this principal address this App"
// and lets `requireWideMemberships` still throw loudly on a wide principal whose
// memberships were never populated.
function appScopeError(principal: Principal, appId: string | undefined): ErrorResponse | null {
  if (appId === undefined || appAccessCovers(principal, appId)) return null;
  return { code: "FORBIDDEN", message: "credential is not scoped to this app", details: {} };
}

function canonicalAppId(selector: string | undefined): string | undefined {
  return selector?.startsWith(APP_ID_PREFIX) ? selector : undefined;
}

function flagLookupBy(contractId: string, request: Request): "auto" | "key" {
  // The raw selector is intentionally first-wins, matching the Panel claim
  // parser. Parsed query records are last-wins, so reading them here would make
  // `?by=id&by=key` resolve the collision as a key instead.
  return contractId === "flags_get" && new URL(request.url).searchParams.get("by") === "key"
    ? "key"
    : "auto";
}

function canonicalEnvironmentLookup(request: Request): boolean {
  return new URL(request.url).searchParams.get("by") === "id";
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
