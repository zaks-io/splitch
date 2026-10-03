import type { FlagInventoryHealthResponse } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import {
  ageDistributionFromCreatedAts,
  countsByLifecycleClassFromRows,
  monthlyChurnFromLogMonths,
} from "./flag-inventory-health-assemble";
import { pathParam } from "./handler-input";

/**
 * Per-App Flag inventory health (plan 3.8). Monthly additions and removals both
 * read the Flag change log so a deleted Flag still counts in its creation month.
 * `asOf` is captured after inventory reads so a concurrent create cannot produce
 * a negative age against a stale timestamp.
 */
export async function getFlagInventoryHealth(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const scope = appScope(appId);
  const app = await deps.repo.identity.getApp(appId);
  if (!app) return appNotFound(requestId);

  const [classRows, createdAts, creationMonths, deletionMonths, earliestLog] = await Promise.all([
    deps.repo.flagHealth.countFlagsByLifecycleClass(scope),
    deps.repo.flagHealth.listFlagCreatedAt(scope),
    deps.repo.flagHealth.countFlagCreationsByMonth(scope),
    deps.repo.flagHealth.countFlagDeletionsByMonth(scope),
    deps.repo.flagHealth.earliestChangeLogAt(scope),
  ]);

  // Snapshot after reads: any Flag returned above has createdAt <= this instant.
  const asOf = nowIso(deps);
  const expiredButLiveCount = await deps.repo.flagHealth.countExpiredFlags(scope, asOf);

  const body: FlagInventoryHealthResponse = {
    appId,
    asOf,
    countsByLifecycleClass: countsByLifecycleClassFromRows(classRows),
    ageDistribution: ageDistributionFromCreatedAts(asOf, createdAts),
    monthlyChurn: monthlyChurnFromLogMonths(asOf, earliestLog, creationMonths, deletionMonths),
    expiredButLiveCount,
  };
  return Response.json(body);
}
