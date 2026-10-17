import { routeRegistry } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import type { AuthenticatedInputResolution } from "@splitch/worker-runtime";
import { environmentExpiredError, environmentHasExpired } from "./temporary-environment-errors";

const routeEffects = new Map(routeRegistry.map((route) => [route.id as string, route.effects]));

export async function refuseExpiredEnvironmentMutation(
  repo: Repository,
  routeId: string,
  result: AuthenticatedInputResolution,
  nowIso?: () => string,
): Promise<AuthenticatedInputResolution> {
  const effects = routeEffects.get(routeId);
  if (!effects) throw new Error(`Missing route effects for ${routeId}`);
  if (!result.ok || !effects.mutates || routeId === "environments_delete") return result;
  const environmentId =
    result.params.targetEnvironmentId ??
    result.params.environmentId ??
    result.principal.environmentId;
  const appId = result.params.appId ?? result.principal.appId;
  if (!appId || !environmentId) return result;
  const environment = await repo.identity.getEnvironment(appScope(appId), environmentId);
  return environment && environmentHasExpired(environment, nowIso?.() ?? new Date().toISOString())
    ? { ok: false, error: environmentExpiredError(environment) }
    : result;
}
