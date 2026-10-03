import {
  FLAG_AGE_BUCKETS,
  flagAgeBucket,
  type FlagInventoryHealthResponse,
} from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import { pathParam } from "./handler-input";

type LifecycleClassCounts = {
  release: number;
  experiment: number;
  ops: number;
  permission: number;
  unclassified: number;
};

const EMPTY_CLASS_COUNTS: LifecycleClassCounts = {
  release: 0,
  experiment: 0,
  ops: 0,
  permission: 0,
  unclassified: 0,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Per-App Flag inventory health (plan 3.8). Removals use the Flag change log
 * (deletes carry `changedAt`); additions use live Flags' `createdAt`.
 */
export async function getFlagInventoryHealth(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const scope = appScope(appId);
  const asOf = nowIso(deps);
  const app = await deps.repo.identity.getApp(appId);
  if (!app) return appNotFound(requestId);

  const [classRows, createdAts, expiredButLiveCount, deletionMonths] = await Promise.all([
    deps.repo.flagHealth.countFlagsByLifecycleClass(scope),
    deps.repo.flagHealth.listFlagCreatedAt(scope),
    deps.repo.flagHealth.countExpiredFlags(scope, asOf),
    deps.repo.flagHealth.countFlagDeletionsByMonth(scope),
  ]);

  const countsByLifecycleClass = { ...EMPTY_CLASS_COUNTS };
  for (const row of classRows) {
    if (!(row.lifecycleClass in countsByLifecycleClass)) {
      throw new Error(`flag_inventory_health_get: unknown lifecycleClass "${row.lifecycleClass}"`);
    }
    countsByLifecycleClass[row.lifecycleClass as keyof typeof countsByLifecycleClass] = row.count;
  }

  const ageCounts = Object.fromEntries(FLAG_AGE_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    (typeof FLAG_AGE_BUCKETS)[number],
    number
  >;
  const addedByMonth = new Map<string, number>();
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new Error(`flag_inventory_health_get: asOf is not a valid instant: ${asOf}`);
  }
  for (const { createdAt } of createdAts) {
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs)) {
      throw new Error(
        `flag_inventory_health_get: Flag createdAt is not a valid instant: ${createdAt}`,
      );
    }
    ageCounts[flagAgeBucket((asOfMs - createdMs) / MS_PER_DAY)] += 1;
    const month = createdAt.slice(0, 7);
    addedByMonth.set(month, (addedByMonth.get(month) ?? 0) + 1);
  }

  const removedByMonth = new Map(deletionMonths.map((row) => [row.month, row.count]));
  const months = [...new Set([...addedByMonth.keys(), ...removedByMonth.keys()])].sort();

  const body: FlagInventoryHealthResponse = {
    appId,
    asOf,
    countsByLifecycleClass,
    ageDistribution: FLAG_AGE_BUCKETS.map((bucket) => ({
      bucket,
      count: ageCounts[bucket],
    })),
    monthlyChurn: {
      months: months.map((month) => ({
        month,
        added: addedByMonth.get(month) ?? 0,
        removed: removedByMonth.get(month) ?? 0,
      })),
      additionsSource: "flag_created_at",
      removalsSource: "flag_change_log",
    },
    expiredButLiveCount,
  };
  return Response.json(body);
}
