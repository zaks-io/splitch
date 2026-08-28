import type { ErrorResponse } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import type {
  AuthenticatedInputResolution,
  AuthenticatedInputResolver,
  Principal,
} from "@splitch/worker-runtime";

const APP_ID_PREFIX = "app_";
const ENVIRONMENT_ID_PREFIX = "env_";
const FLAG_ID_PREFIX = "flag_";

/** Resolve human-readable path selectors inside the authenticated request. */
export function makePathSelectorResolver(repo: Repository): AuthenticatedInputResolver {
  return ({ contract, input, params, principal, request }) =>
    resolveControlPlanePathSelectors(
      repo,
      input,
      params,
      principal,
      contract.id === "flags_get" && new URL(request.url).searchParams.has("by"),
    );
}

export async function resolveControlPlanePathSelectors(
  repo: Repository,
  input: unknown,
  params: Record<string, string>,
  principal: Principal,
  preserveFlagSelector = false,
): Promise<AuthenticatedInputResolution> {
  const resolvedParams = { ...params };

  const app = await resolveApp(repo, principal, params.appId);
  if (!app.ok) return app;
  assignResolved(resolvedParams, "appId", app.appId);

  const environment = await resolveEnvironment(repo, resolvedParams.appId, params.environmentId);
  if (!environment.ok) return environment;
  assignResolved(resolvedParams, "environmentId", environment.environmentId);

  const target = await resolveEnvironment(repo, resolvedParams.appId, params.targetEnvironmentId);
  if (!target.ok) return target;
  assignResolved(resolvedParams, "targetEnvironmentId", target.environmentId);

  if (!preserveFlagSelector) {
    const flag = await resolveFlag(repo, resolvedParams.appId, params.flagId);
    if (!flag.ok) return flag;
    assignResolved(resolvedParams, "flagId", flag.flagId);
  }

  return {
    ok: true,
    input: withResolvedParams(input, resolvedParams),
    params: resolvedParams,
    principal: app.appId ? bindResolvedApp(principal, params.appId, app.appId) : principal,
  };
}

async function resolveApp(
  repo: Repository,
  principal: Principal,
  selector: string | undefined,
): Promise<{ ok: true; appId?: string } | { ok: false; error: ErrorResponse }> {
  if (selector === undefined || selector.startsWith(APP_ID_PREFIX)) return { ok: true };
  const candidates = await repo.identity.findAppSelectorCandidatesForUser(principal.id, selector);
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
  if (selector === undefined || selector.startsWith(ENVIRONMENT_ID_PREFIX)) return { ok: true };
  if (!appId?.startsWith(APP_ID_PREFIX)) return failure("APP_NOT_FOUND", "app not found");
  const environment = await repo.identity.getEnvironmentByKey(appScope(appId), selector);
  return environment
    ? { ok: true, environmentId: environment.id }
    : failure("APP_NOT_FOUND", "app not found");
}

async function resolveFlag(
  repo: Repository,
  appId: string | undefined,
  selector: string | undefined,
): Promise<{ ok: true; flagId?: string } | { ok: false; error: ErrorResponse }> {
  if (selector === undefined || selector.startsWith(FLAG_ID_PREFIX)) return { ok: true };
  if (!appId?.startsWith(APP_ID_PREFIX)) return failure("APP_NOT_FOUND", "app not found");
  const flag = await repo.flags.getFlagByKey(appScope(appId), selector);
  return flag ? { ok: true, flagId: flag.id } : failure("FLAG_NOT_FOUND", "flag not found");
}

function bindResolvedApp(
  principal: Principal,
  selector: string | undefined,
  appId: string,
): Principal {
  if (
    selector?.startsWith(APP_ID_PREFIX) ||
    principal.appId !== null ||
    !hasAppScope(principal.scopes, appId)
  ) {
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

function withResolvedParams(input: unknown, params: Record<string, string>): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("path selector resolver received non-object parsed input");
  }
  return { ...input, params };
}

function failure(
  code: "APP_NOT_FOUND" | "FLAG_NOT_FOUND",
  message: string,
): { ok: false; error: ErrorResponse } {
  return { ok: false, error: { code, message, details: {} } };
}
