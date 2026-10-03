import { and, count, eq, gte, isNotNull, lte, max, sql, type SQL } from "drizzle-orm";
import { flagChangeEvents } from "../schema/flag-change-events";
import { flags } from "../schema/index";
import type { Db } from "./client";
import { assertMintedScope, type TenantScope, withTenantScope } from "./scope";

const FLAG_SCOPE = {
  appId: flags.appId,
  appIdKey: "appId",
} as const;

const CHANGE_SCOPE = {
  appId: flagChangeEvents.appId,
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

    /**
     * Deletion months from the change log (`action=deleted`, `target_type=flag`).
     * Flag DEFINITION deletes always carry a `changedAt`, so removals are known
     * for every delete that happened after the log existed (migration 0026).
     */
    async countFlagDeletionsByMonth(scope: TenantScope): Promise<MonthCountRow[]> {
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
              and(eq(flagChangeEvents.action, "deleted"), eq(flagChangeEvents.targetType, "flag")),
              "deletion predicate",
            ),
          ),
        )
        .groupBy(monthExpr)
        .orderBy(monthExpr);
      return rows.map((row) => ({ month: row.month, count: Number(row.count) }));
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
  };
}
