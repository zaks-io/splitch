import { and, desc, eq, gte, sql } from "drizzle-orm";
import { flagConfigs, targetingRules } from "../schema/index";
import {
  appliedRequestUpdate,
  appliedReviewInsert,
  appliedReviewQueries,
  approvalPendingCondition,
  approvalReviewLanded,
  reviewRecorded,
} from "./approval-atomic";
import type { ApprovalCommit } from "./approval-types";
import type { Db } from "./client";
import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

/**
 * Per-Environment Flag CONFIGURATION reads and writes (ADR-0027), split out of
 * `makeFlagRepo` so the flag repo stays readable as the config surface grows.
 * Every operation takes an `EnvScope`, so the tenant boundary is the same one
 * `scopedTable` enforces for the rest of the domain.
 */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: these operations share the same scoped config and targeting-rule tables
export function makeFlagConfigOps(
  db: Db,
  flagConfigsTable: ScopedTable<typeof flagConfigs>,
  targetingRulesTable: ScopedTable<typeof targetingRules>,
) {
  return {
    getFlagConfig(scope: EnvScope, flagId: string) {
      return flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
    },

    getFlagConfigById(scope: EnvScope, configId: string) {
      return flagConfigsTable.findOne(scope, eq(flagConfigs.id, configId));
    },

    /**
     * Flag Configurations in this Environment changed at or after `since`, most
     * recently changed first, bounded to `limit` rows.
     *
     * Exists so a "what changed lately" surface costs what it renders instead of
     * what the Environment holds: the unbounded read this replaces made every
     * page load scale with the App's Flag count.
     *
     * `updated_at` is fixed-width ISO-8601 TEXT, so the lexicographic comparison
     * SQLite applies IS the chronological one — no conversion, and the `>=` bound
     * and the DESC order agree with how a caller reads the column in JS.
     *
     * Ordered by `(updated_at DESC, id DESC)`. `id` is the table's PRIMARY KEY, so
     * the pair is a TOTAL order. Timestamps collide (a batch write stamps one
     * `updated_at` across rows), and without the tiebreaker which of the tied rows
     * a `LIMIT` dropped would vary between two otherwise identical reads.
     *
     * Ask for one row more than you intend to keep and you learn whether you
     * truncated, rather than inferring it from a full page.
     */
    listRecentFlagConfigs(scope: EnvScope, since: string, limit: number) {
      return flagConfigsTable.findMany(scope, gte(flagConfigs.updatedAt, since), {
        limit,
        orderBy: [desc(flagConfigs.updatedAt), desc(flagConfigs.id)],
      });
    },

    /**
     * Insert the initial disabled Flag Configuration when absent. Retries against
     * the `(flag_id, environment_id)` unique index return the existing row.
     */
    async ensureInitialFlagConfig(
      scope: EnvScope,
      values: Omit<typeof flagConfigs.$inferInsert, "appId" | "environmentId"> & {
        flagId: string;
      },
    ): Promise<typeof flagConfigs.$inferSelect> {
      const existing = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, values.flagId));
      if (existing) return existing;

      try {
        return await flagConfigsTable.insert(scope, {
          ...values,
          appId: scope.appId,
          environmentId: scope.environmentId,
        });
      } catch (cause) {
        const winner = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, values.flagId));
        if (winner) return winner;
        throw cause;
      }
    },

    removeFlagConfig(scope: EnvScope, flagId: string): Promise<number> {
      return flagConfigsTable.remove(scope, eq(flagConfigs.flagId, flagId));
    },

    removeTargetingRules(scope: EnvScope, flagId: string): Promise<number> {
      return targetingRulesTable.remove(scope, eq(targetingRules.flagId, flagId));
    },

    async updateFlagConfig(
      scope: EnvScope,
      flagId: string,
      patch: Partial<
        Pick<
          typeof flagConfigs.$inferInsert,
          "enabled" | "availableVariantNames" | "defaultVariantId" | "rollout" | "updatedAt"
        >
      >,
      approval?: ApprovalCommit,
    ): Promise<typeof flagConfigs.$inferSelect | null> {
      const current = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
      if (!current) return null;
      if (approval) {
        const mutation = db
          .update(flagConfigs)
          .set({ ...patch, version: current.version + 1 })
          .where(
            and(
              scopedFlagConfig(scope, flagId),
              eq(flagConfigs.version, current.version),
              approvalPendingCondition(db, scope, approval),
            ),
          )
          .returning({ id: flagConfigs.id });
        // `changes() = 1` binds the Review to this exact mutation statement.
        await db.batch([
          mutation,
          ...appliedReviewQueries(db, scope, approval),
        ] as unknown as Parameters<Db["batch"]>[0]);
        // The guard can lose (request resolved, reviewer role revoked, Policy
        // level changed, version CAS lost) and leave every statement a no-op.
        // Returning the re-read row would report that as an applied change.
        if (!(await approvalReviewLanded(db, scope, approval))) return null;
        return flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
      }
      const rows = await flagConfigsTable.update(
        scope,
        { ...patch, version: current.version + 1 },
        eq(flagConfigs.flagId, flagId),
      );
      return rows[0] ?? null;
    },

    listTargetingRules(scope: EnvScope, flagId: string) {
      return targetingRulesTable.findMany(scope, eq(targetingRules.flagId, flagId));
    },

    async replaceTargetingRules(
      scope: EnvScope,
      flagId: string,
      rows: Array<Omit<typeof targetingRules.$inferInsert, "appId" | "environmentId" | "flagId">>,
      configPatch: Partial<
        Pick<
          typeof flagConfigs.$inferInsert,
          "enabled" | "availableVariantNames" | "rollout" | "updatedAt"
        >
      >,
      approval?: ApprovalCommit,
    ): Promise<typeof flagConfigs.$inferSelect | null> {
      assertMintedScope(scope);
      const current = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
      if (!current) return null;

      if (approval) {
        // The Review row is this attempt's unique evidence: the rule writes ride
        // along with it, and it is itself bound to the config bump by changes().
        const evidence = reviewRecorded(db, scope, approval);
        const guardedDelete = db
          .delete(targetingRules)
          .where(and(scopedTargetingRule(scope, flagId), evidence))
          .returning();
        const guardedInserts = rows.map((row) =>
          db.insert(targetingRules).select(
            db
              .select({
                id: sql<string>`${row.id}`.as("id"),
                appId: sql<string>`${scope.appId}`.as("app_id"),
                environmentId: sql<string>`${scope.environmentId}`.as("environment_id"),
                flagId: sql<string>`${flagId}`.as("flag_id"),
                priority: sql<number>`${row.priority}`.as("priority"),
                conditions: sql<string>`${row.conditions}`.as("conditions"),
                variantId: sql<string | null>`${row.variantId ?? null}`.as("variant_id"),
                percentageRollout: sql<string | null>`${row.percentageRollout ?? null}`.as(
                  "percentage_rollout",
                ),
                createdAt: sql<string>`${row.createdAt}`.as("created_at"),
                updatedAt: sql<string>`${row.updatedAt}`.as("updated_at"),
              })
              .from(flagConfigs)
              .where(and(scopedFlagConfig(scope, flagId), evidence))
              .limit(1),
          ),
        );
        const guardedUpdate = db
          .update(flagConfigs)
          .set({ ...configPatch, version: current.version + 1 })
          .where(
            and(
              scopedFlagConfig(scope, flagId),
              eq(flagConfigs.version, current.version),
              approvalPendingCondition(db, scope, approval),
            ),
          )
          .returning();
        await db.batch([
          guardedUpdate,
          appliedReviewInsert(db, scope, approval),
          guardedDelete,
          ...guardedInserts,
          appliedRequestUpdate(db, scope, approval),
        ] as unknown as Parameters<Db["batch"]>[0]);
        if (!(await approvalReviewLanded(db, scope, approval))) return null;
        return flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
      }

      const batch = [
        db.delete(targetingRules).where(scopedTargetingRule(scope, flagId)).returning(),
        ...rows.map((row) =>
          db
            .insert(targetingRules)
            .values({
              ...row,
              appId: scope.appId,
              environmentId: scope.environmentId,
              flagId,
            })
            .returning(),
        ),
        db
          .update(flagConfigs)
          .set({ ...configPatch, version: current.version + 1 })
          .where(scopedFlagConfig(scope, flagId))
          .returning(),
      ];
      const results = await db.batch(batch as unknown as Parameters<Db["batch"]>[0]);
      const updated = results.at(-1) as (typeof flagConfigs.$inferSelect)[] | undefined;
      return updated?.[0] ?? null;
    },
  };
}

export function scopedTargetingRule(scope: EnvScope, flagId: string) {
  return and(
    eq(targetingRules.appId, scope.appId),
    eq(targetingRules.environmentId, scope.environmentId),
    eq(targetingRules.flagId, flagId),
  );
}

export function scopedFlagConfig(scope: EnvScope, flagId: string) {
  return and(
    eq(flagConfigs.appId, scope.appId),
    eq(flagConfigs.environmentId, scope.environmentId),
    eq(flagConfigs.flagId, flagId),
  );
}
