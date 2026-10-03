import {
  FLAG_AGE_BUCKETS,
  flagAgeBucket,
  type FlagInventoryHealthResponse,
} from "@splitch/contracts";
import { changeLogCoverageStartsAt, monthChurnCoverage } from "./flag-inventory-health-coverage";

type LifecycleClassCounts = FlagInventoryHealthResponse["countsByLifecycleClass"];

const EMPTY_CLASS_COUNTS: LifecycleClassCounts = {
  release: 0,
  experiment: 0,
  ops: 0,
  permission: 0,
  unclassified: 0,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function countsByLifecycleClassFromRows(
  classRows: ReadonlyArray<{ lifecycleClass: string; count: number }>,
): LifecycleClassCounts {
  const counts = { ...EMPTY_CLASS_COUNTS };
  for (const row of classRows) {
    if (!(row.lifecycleClass in counts)) {
      throw new Error(`flag_inventory_health_get: unknown lifecycleClass "${row.lifecycleClass}"`);
    }
    counts[row.lifecycleClass as keyof LifecycleClassCounts] = row.count;
  }
  return counts;
}

export function ageDistributionFromCreatedAts(
  asOf: string,
  createdAts: ReadonlyArray<{ createdAt: string }>,
): FlagInventoryHealthResponse["ageDistribution"] {
  const ageCounts = Object.fromEntries(FLAG_AGE_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    (typeof FLAG_AGE_BUCKETS)[number],
    number
  >;
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
  }
  return FLAG_AGE_BUCKETS.map((bucket) => ({ bucket, count: ageCounts[bucket] }));
}

export function monthlyChurnFromLogMonths(
  asOf: string,
  earliestLog: string | null,
  creationMonths: ReadonlyArray<{ month: string; count: number }>,
  deletionMonths: ReadonlyArray<{ month: string; count: number }>,
): FlagInventoryHealthResponse["monthlyChurn"] {
  const historyCoverageStartsAt = changeLogCoverageStartsAt(asOf, earliestLog);
  const addedByMonth = new Map(creationMonths.map((row) => [row.month, row.count]));
  const removedByMonth = new Map(deletionMonths.map((row) => [row.month, row.count]));
  const months = [...new Set([...addedByMonth.keys(), ...removedByMonth.keys()])].sort();
  if (months.length > 0 && historyCoverageStartsAt === null) {
    throw new Error(
      "flag_inventory_health_get: monthly churn rows exist but historyCoverageStartsAt is null",
    );
  }
  return {
    months:
      historyCoverageStartsAt === null
        ? []
        : months.map((month) => ({
            month,
            added: addedByMonth.get(month) ?? 0,
            removed: removedByMonth.get(month) ?? 0,
            coverage: monthChurnCoverage(month, historyCoverageStartsAt),
          })),
    additionsSource: "flag_change_log",
    removalsSource: "flag_change_log",
    historyCoverageStartsAt,
  };
}
