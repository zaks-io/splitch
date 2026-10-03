import { and, count, eq, gte, inArray, isNotNull, lte, max, min, sql, type SQL } from "drizzle-orm";
import { experiments, flagChangeEvents, flags, runs } from "../schema/index";
import type { Db } from "./client";
import { twoAxisIdBatches } from "./id-batches";
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

function requireSql(value: SQL | undefined, label: string): SQL {
  if (!value) throw new Error(`flag-health-reads: ${label} produced no SQL`);
  return value;
}

export type LifecycleClassCountRow = {
  lifecycleClass: string;
  count: number;
};

export type MonthCountRow = {
  month: string;
  count: number;
};

async function countFlagActionByMonth(
  db: Db,
  scope: TenantScope,
  action: "created" | "deleted",
  label: string,
): Promise<MonthCountRow[]> {
  assertMintedScope(scope);
  const monthExpr = sql<string>`substr(${flagChangeEvents.changedAt}, 1, 7)`;
  const rows = await db
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
  return rows.map((row) => ({ month: row.month, count: Number(row.count) }));
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

/**
 * Aggregations for Flag inventory health (plan 3.8) and the latest change-log
 * instant per Flag for stale unchanged detection (plan 3.6). All reads bind a
 * minted TenantScope; none invent defaults for missing data.
 */
export function makeFlagHealthReads(db: Db) {
  return {
    async countFlagsByLifecycleClass(scope: TenantScope): Promise<LifecycleClassCountRow[]> {
      assertMintedScope(scope);
      const rows = await db
        .select({
          lifecycleClass: flags.lifecycleClass,
          count: count(),
        })
        .from(flags)
        .where(withTenantScope(FLAG_SCOPE, scope, anyFlag))
        .groupBy(flags.lifecycleClass);
      return rows.map((row) => ({
        lifecycleClass: row.lifecycleClass,
        count: Number(row.count),
      }));
    },

    async listFlagCreatedAt(scope: TenantScope): Promise<Array<{ createdAt: string }>> {
      assertMintedScope(scope);
      return db
        .select({ createdAt: flags.createdAt })
        .from(flags)
        .where(withTenantScope(FLAG_SCOPE, scope, anyFlag));
    },

    async countExpiredFlags(scope: TenantScope, now: string): Promise<number> {
      assertMintedScope(scope);
      const [row] = await db
        .select({ count: count() })
        .from(flags)
        .where(
          withTenantScope(
            FLAG_SCOPE,
            scope,
            requireSql(
              and(isNotNull(flags.expiresAt), lte(flags.expiresAt, now)),
              "expired predicate",
            ),
          ),
        );
      return Number(row?.count ?? 0);
    },

    /** Creation months from the change log; survives hard delete. */
    countFlagCreationsByMonth(scope: TenantScope): Promise<MonthCountRow[]> {
      return countFlagActionByMonth(db, scope, "created", "creation predicate");
    },

    /** Deletion months from the change log (`action=deleted`, `target_type=flag`). */
    countFlagDeletionsByMonth(scope: TenantScope): Promise<MonthCountRow[]> {
      return countFlagActionByMonth(db, scope, "deleted", "deletion predicate");
    },

    /**
     * Earliest change-log instant for the App. Null when the App has no log rows
     * yet: addition/removal months before that instant are not covered (Flags
     * that predate migration 0026 have no create event).
     */
    async earliestChangeLogAt(scope: TenantScope): Promise<string | null> {
      assertMintedScope(scope);
      const [row] = await db
        .select({ earliest: min(flagChangeEvents.changedAt) })
        .from(flagChangeEvents)
        .where(withTenantScope(CHANGE_SCOPE, scope, gte(flagChangeEvents.seq, 0)));
      return row?.earliest ?? null;
    },

    /**
     * Latest change-log `changedAt` per Flag id in the App. Used for the
     * unchanged stale signal; Flags with no log row fall back to `flags.updatedAt`
     * in the detector.
     */
    async latestChangeAtByFlagId(scope: TenantScope): Promise<Map<string, string>> {
      assertMintedScope(scope);
      const rows = await db
        .select({
          flagId: flagChangeEvents.flagId,
          lastChangedAt: max(flagChangeEvents.changedAt),
        })
        .from(flagChangeEvents)
        .where(withTenantScope(CHANGE_SCOPE, scope, gte(flagChangeEvents.seq, 0)))
        .groupBy(flagChangeEvents.flagId);
      const out = new Map<string, string>();
      for (const row of rows) {
        if (row.lastChangedAt === null) {
          throw new Error(
            `latestChangeAtByFlagId: Flag ${row.flagId} has change-log rows but no changedAt`,
          );
        }
        out.set(row.flagId, row.lastChangedAt);
      }
      return out;
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
