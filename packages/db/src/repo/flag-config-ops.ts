import { and, eq } from "drizzle-orm";
import { flagConfigs, targetingRules } from "../schema/index";
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
export function makeFlagConfigOps(
  db: Db,
  flagConfigsTable: ScopedTable<typeof flagConfigs>,
  targetingRulesTable: ScopedTable<typeof targetingRules>,
) {
  return {
    getFlagConfig(scope: EnvScope, flagId: string) {
      return flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
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
          | "enabled"
          | "availableVariantNames"
          | "defaultVariantId"
          | "rollout"
          | "updatedAt"
          | "version"
        >
      >,
    ): Promise<typeof flagConfigs.$inferSelect | null> {
      const current = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
      if (!current) return null;
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
    ): Promise<typeof flagConfigs.$inferSelect | null> {
      assertMintedScope(scope);
      const current = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
      if (!current) return null;

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
