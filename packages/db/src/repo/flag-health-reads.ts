import { and, count, eq, gte, inArray, isNotNull, lte, max, min, sql, type SQL } from "drizzle-orm";
import { experiments, flagChangeEvents, flags, runs } from "../schema/index";
import type { Db } from "./client";
import { idBatches, twoAxisIdBatches } from "./id-batches";
import { assertMintedScope, type TenantScope, withTenantScope } from "./scope";

const FLAG_SCOPE = {
  appId: flags.appId,
  appIdKey: "appId",
} as const;

const CHANGE_SCOPE = {
  appId: flagChangeEvents.appId,
  appIdKey: "appId",
} as const;

const RUN_SCOPE = {
  appId: runs.appId,
  appIdKey: "appId",
} as const;

/** withTenantScope requires an extra predicate; PK non-null is always true. */
const anyFlag = isNotNull(flags.id);

/**
 * Age bucket keys mirror `@splitch/contracts` FLAG_AGE_BUCKETS. Bounds are
 * inlined in the SQL CASE arms below so `@splitch/db` does not depend on contracts.
 */
const AGE_BUCKETS = ["0_30d", "30_90d", "90_180d", "180_365d", "365d_plus"] as const;

type LifecycleClassCountRow = {
  lifecycleClass: string;
  count: number;
};

type MonthCountRow = {
  month: string;
  count: number;
};

type AgeBucketCountRow = {
  bucket: (typeof AGE_BUCKETS)[number];
  count: number;
};

type FlagInventoryHealthAggregates = {
  classRows: LifecycleClassCountRow[];
  ageBuckets: AgeBucketCountRow[];
  creationMonths: MonthCountRow[];
  deletionMonths: MonthCountRow[];
  earliestLog: string | null;
  expiredButLiveCount: number;
};

function requireSql(value: SQL | undefined, label: string): SQL {
  if (!value) throw new Error(`flag-health-reads: ${label} produced no SQL`);
  return value;
}

function flagActionByMonthQuery(
  db: Db,
  scope: TenantScope,
  action: "created" | "deleted",
  label: string,
) {
  const monthExpr = sql<string>`substr(${flagChangeEvents.changedAt}, 1, 7)`;
  return db
    .select({
      month: monthExpr,
      count: count(),
    })
    .from(flagChangeEvents)
    .where(
      withTenantScope(
        CHANGE_SCOPE,
        scope,
        requireSql(
          and(eq(flagChangeEvents.action, action), eq(flagChangeEvents.targetType, "flag")),
          label,
        ),
      ),
    )
    .groupBy(monthExpr)
    .orderBy(monthExpr);
}

function mapMonthRows(rows: Array<{ month: string; count: number }>): MonthCountRow[] {
  return rows.map((row) => ({ month: row.month, count: Number(row.count) }));
}

/**
 * One SELECT returning five fixed bucket columns. max(0, age) clamps a Flag
 * whose createdAt is slightly after asOf (Worker vs insert clock) into 0_30d
 * instead of dropping it and disagreeing with class totals.
 */
function ageBucketCountsQuery(db: Db, scope: TenantScope, asOf: string) {
  const ageDays = sql`max(0, julianday(${asOf}) - julianday(${flags.createdAt}))`;
  return db
    .select({
      c0_30d: sql<number>`coalesce(sum(case when ${ageDays} < 30 then 1 else 0 end), 0)`,
      c30_90d: sql<number>`coalesce(sum(case when ${ageDays} >= 30 and ${ageDays} < 90 then 1 else 0 end), 0)`,
      c90_180d: sql<number>`coalesce(sum(case when ${ageDays} >= 90 and ${ageDays} < 180 then 1 else 0 end), 0)`,
      c180_365d: sql<number>`coalesce(sum(case when ${ageDays} >= 180 and ${ageDays} < 365 then 1 else 0 end), 0)`,
      c365d_plus: sql<number>`coalesce(sum(case when ${ageDays} >= 365 then 1 else 0 end), 0)`,
    })
    .from(flags)
    .where(withTenantScope(FLAG_SCOPE, scope, anyFlag));
}

function ageBucketsFromAggregateRow(
  row:
    | {
        c0_30d: number;
        c30_90d: number;
        c90_180d: number;
        c180_365d: number;
        c365d_plus: number;
      }
    | undefined,
): AgeBucketCountRow[] {
  const counts = {
    "0_30d": Number(row?.c0_30d ?? 0),
    "30_90d": Number(row?.c30_90d ?? 0),
    "90_180d": Number(row?.c90_180d ?? 0),
    "180_365d": Number(row?.c180_365d ?? 0),
    "365d_plus": Number(row?.c365d_plus ?? 0),
  };
  return AGE_BUCKETS.map((bucket) => ({ bucket, count: counts[bucket] }));
}

async function loadLatestRunLifecycleAtByFlagEnv(
  db: Db,
  scope: TenantScope,
  flagIds: readonly string[],
  environmentIds: readonly string[],
): Promise<Map<string, string>> {
  assertMintedScope(scope);
  if (flagIds.length === 0 || environmentIds.length === 0) return new Map();
  const out = new Map<string, string>();
  const pages = await Promise.all(
    twoAxisIdBatches(flagIds, environmentIds).map(({ first, second }) =>
      db
        .select({
          flagId: experiments.flagId,
          environmentId: runs.environmentId,
          latestStartedAt: max(runs.startedAt),
          latestEndedAt: max(runs.endedAt),
        })
        .from(runs)
        .innerJoin(
          experiments,
          and(eq(experiments.id, runs.experimentId), eq(experiments.appId, runs.appId)),
        )
        .where(
          withTenantScope(
            RUN_SCOPE,
            scope,
            requireSql(
              and(inArray(experiments.flagId, first), inArray(runs.environmentId, second)),
              "run lifecycle predicate",
            ),
          ),
        )
        .groupBy(experiments.flagId, runs.environmentId),
    ),
  );
  for (const row of pages.flat()) {
    const candidates = [row.latestStartedAt, row.latestEndedAt].filter(
      (value): value is string => value !== null,
    );
    if (candidates.length === 0) {
      throw new Error(
        `latestRunLifecycleAtByFlagEnv: Flag ${row.flagId} env ${row.environmentId} has Runs but no lifecycle instant`,
      );
    }
    out.set(
      `${row.flagId}\0${row.environmentId}`,
      candidates.reduce((a, b) => (a > b ? a : b)),
    );
  }
  return out;
}

async function loadLatestChangeAtByFlagIds(
  db: Db,
  scope: TenantScope,
  flagIds: readonly string[],
): Promise<Map<string, string>> {
  assertMintedScope(scope);
  if (flagIds.length === 0) return new Map();
  const pages = await Promise.all(
    idBatches(flagIds).map((batch) =>
      db
        .select({
          flagId: flagChangeEvents.flagId,
          lastChangedAt: max(flagChangeEvents.changedAt),
        })
        .from(flagChangeEvents)
        .where(
          withTenantScope(
            CHANGE_SCOPE,
            scope,
            requireSql(inArray(flagChangeEvents.flagId, batch), "latest change flagIds"),
          ),
        )
        .groupBy(flagChangeEvents.flagId),
    ),
  );
  const out = new Map<string, string>();
  for (const row of pages.flat()) {
    if (row.lastChangedAt === null) {
      throw new Error(
        `latestChangeAtByFlagId: Flag ${row.flagId} has change-log rows but no changedAt`,
      );
    }
    out.set(row.flagId, row.lastChangedAt);
  }
  return out;
}

/**
 * Aggregations for Flag inventory health (plan 3.8) and the latest change-log
 * instant per Flag for stale unchanged detection (plan 3.6). All reads bind a
 * minted TenantScope; none invent defaults for missing data.
 */
export function makeFlagHealthReads(db: Db) {
  return {
    /**
     * Inventory + churn aggregates in one D1 batch so concurrent Flag create /
     * delete cannot make earliestChangeLogAt, monthly churn, class totals, age
     * buckets, and expired counts disagree.
     */
    async loadInventoryHealthAggregates(
      scope: TenantScope,
      asOf: string,
    ): Promise<FlagInventoryHealthAggregates> {
      assertMintedScope(scope);
      const classQuery = db
        .select({
          lifecycleClass: flags.lifecycleClass,
          count: count(),
        })
        .from(flags)
        .where(withTenantScope(FLAG_SCOPE, scope, anyFlag))
        .groupBy(flags.lifecycleClass);
      const ageQuery = ageBucketCountsQuery(db, scope, asOf);
      const creationQuery = flagActionByMonthQuery(db, scope, "created", "creation predicate");
      const deletionQuery = flagActionByMonthQuery(db, scope, "deleted", "deletion predicate");
      const earliestQuery = db
        .select({ earliest: min(flagChangeEvents.changedAt) })
        .from(flagChangeEvents)
        .where(withTenantScope(CHANGE_SCOPE, scope, gte(flagChangeEvents.seq, 0)));
      const expiredQuery = db
        .select({ count: count() })
        .from(flags)
        .where(
          withTenantScope(
            FLAG_SCOPE,
            scope,
            requireSql(
              and(isNotNull(flags.expiresAt), lte(flags.expiresAt, asOf)),
              "expired predicate",
            ),
          ),
        );

      const [classRows, ageRows, creationMonths, deletionMonths, earliestRows, expiredRows] =
        await db.batch([
          classQuery,
          ageQuery,
          creationQuery,
          deletionQuery,
          earliestQuery,
          expiredQuery,
        ] as unknown as Parameters<Db["batch"]>[0]);

      return {
        classRows: (classRows as Array<{ lifecycleClass: string; count: number }>).map((row) => ({
          lifecycleClass: row.lifecycleClass,
          count: Number(row.count),
        })),
        ageBuckets: ageBucketsFromAggregateRow(
          (
            ageRows as Array<{
              c0_30d: number;
              c30_90d: number;
              c90_180d: number;
              c180_365d: number;
              c365d_plus: number;
            }>
          )[0],
        ),
        creationMonths: mapMonthRows(creationMonths as Array<{ month: string; count: number }>),
        deletionMonths: mapMonthRows(deletionMonths as Array<{ month: string; count: number }>),
        earliestLog: (earliestRows as Array<{ earliest: string | null }>)[0]?.earliest ?? null,
        expiredButLiveCount: Number((expiredRows as Array<{ count: number }>)[0]?.count ?? 0),
      };
    },

    /**
     * Latest change-log `changedAt` for the given Flag ids only. Stale detection
     * evaluates a bounded live page; scanning every historical Flag (including
     * deleted ones still in the log) is unbounded when pruning stalls.
     */
    latestChangeAtByFlagId(
      scope: TenantScope,
      flagIds: readonly string[],
    ): Promise<Map<string, string>> {
      return loadLatestChangeAtByFlagIds(db, scope, flagIds);
    },

    /**
     * Latest Run Start/End instant per Flag × Environment. Uniform serving must
     * not start until after the last Run that controlled that Flag stops; End
     * updates the Run, not the Configuration.
     */
    latestRunLifecycleAtByFlagEnv(
      scope: TenantScope,
      flagIds: readonly string[],
      environmentIds: readonly string[],
    ): Promise<Map<string, string>> {
      return loadLatestRunLifecycleAtByFlagEnv(db, scope, flagIds, environmentIds);
    },
  };
}
