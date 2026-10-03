import type { FlagInventoryHealthResponse } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import {
  ageDistributionFromBucketRows,
  countsByLifecycleClassFromRows,
  monthlyChurnFromLogMonths,
} from "./flag-inventory-health-assemble";
import { pathParam } from "./handler-input";

/**
 * Per-App Flag inventory health (plan 3.8). Monthly additions and removals both
 * read the Flag change log so a deleted Flag still counts in its creation month.
 * Inventory and churn aggregates load in one D1 batch (one snapshot); `asOf` is
 * the instant bound into that batch for age buckets and expired-but-live.
 */
export async function getFlagInventoryHealth(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const scope = appScope(appId);
  const app = await deps.repo.identity.getApp(appId);
  if (!app) return appNotFound(requestId);

  const asOf = nowIso(deps);
  const aggregates = await deps.repo.flagHealth.loadInventoryHealthAggregates(scope, asOf);

  const body: FlagInventoryHealthResponse = {
    appId,
    asOf,
    countsByLifecycleClass: countsByLifecycleClassFromRows(aggregates.classRows),
    ageDistribution: ageDistributionFromBucketRows(aggregates.ageBuckets),
    monthlyChurn: monthlyChurnFromLogMonths(
      asOf,
      aggregates.earliestLog,
      aggregates.creationMonths,
      aggregates.deletionMonths,
    ),
    expiredButLiveCount: aggregates.expiredButLiveCount,
  };
  return Response.json(body);
}
