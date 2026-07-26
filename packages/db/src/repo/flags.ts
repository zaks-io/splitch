import { and, eq, inArray } from "drizzle-orm";
import { flagConfigs, flags, segments, targetingRules, variants } from "../schema/index";
import type { Db } from "./client";
import { makeFlagConfigOps, scopedFlagConfig, scopedTargetingRule } from "./flag-config-ops";
import type { TenantScope } from "./scope";
import { envScope } from "./scope";
import { scopedTable } from "./scoped-table";

/**
 * Flag-domain repository. App-scoped: flags, segments. Per-Environment:
 * flag_configs, targeting_rules. Variants are the one table with no `app_id`
 * column — the catalog is reached transitively through its parent flag
 * (flag_id → flags.app_id), so variant access is gated by first proving the flag
 * is in the caller's App scope. There is no way to read a variant without that
 * App-scoped flag lookup, so the tenant boundary still holds for the catalog.
 */
export function makeFlagRepo(db: Db) {
  const flagsTable = scopedTable(db, flags);
  const flagConfigsTable = scopedTable(db, flagConfigs);
  const targetingRulesTable = scopedTable(db, targetingRules);
  const segmentsTable = scopedTable(db, segments);

  async function flagInScope(
    scope: TenantScope,
    flagId: string,
  ): Promise<typeof flags.$inferSelect | null> {
    return flagsTable.findOne(scope, eq(flags.id, flagId));
  }

  return {
    flags: flagsTable,
    flagConfigs: flagConfigsTable,
    targetingRules: targetingRulesTable,
    segments: segmentsTable,

    getFlag(scope: TenantScope, flagId: string) {
      return flagsTable.findOne(scope, eq(flags.id, flagId));
    },

    updateFlag(
      scope: TenantScope,
      flagId: string,
      patch: Partial<
        Pick<
          typeof flags.$inferInsert,
          "name" | "description" | "schema" | "defaultVariantId" | "updatedAt" | "updatedBy"
        >
      >,
    ): Promise<typeof flags.$inferSelect | null> {
      return flagsTable.update(scope, patch, eq(flags.id, flagId)).then((rows) => rows[0] ?? null);
    },

    removeFlag(scope: TenantScope, flagId: string): Promise<number> {
      return flagsTable.remove(scope, eq(flags.id, flagId));
    },

    deleteFlagCascade: makeDeleteFlagCascade(db, flagInScope),

    ...makeVariantOps(db, flagInScope),

    ...makeFlagConfigOps(db, flagConfigsTable, targetingRulesTable),

    /** App-scoped Segment fetch by a set of IDs (e.g. for a draft Run snapshot). */
    listSegmentsByIds(scope: TenantScope, ids: readonly string[]) {
      if (ids.length === 0) return Promise.resolve([] as (typeof segments.$inferSelect)[]);
      return segmentsTable.findMany(scope, inArray(segments.id, [...ids]));
    },

    getSegment(scope: TenantScope, segmentId: string) {
      return segmentsTable.findOne(scope, eq(segments.id, segmentId));
    },

    updateSegment(
      scope: TenantScope,
      segmentId: string,
      patch: Partial<
        Pick<typeof segments.$inferInsert, "name" | "description" | "conditions" | "updatedAt">
      >,
    ): Promise<typeof segments.$inferSelect | null> {
      return segmentsTable
        .update(scope, patch, eq(segments.id, segmentId))
        .then((rows) => rows[0] ?? null);
    },

    removeSegment(scope: TenantScope, segmentId: string): Promise<number> {
      return segmentsTable.remove(scope, eq(segments.id, segmentId));
    },
  };
}

function makeDeleteFlagCascade(db: Db, flagInScope: FlagInScope) {
  return async function deleteFlagCascade(
    scope: TenantScope,
    flagId: string,
    environmentIds: readonly string[],
  ): Promise<boolean> {
    const flag = await flagInScope(scope, flagId);
    if (!flag) return false;

    const batch = [
      ...environmentIds.flatMap((environmentId) => {
        const env = envScope(scope.appId, environmentId);
        return [
          db.delete(targetingRules).where(scopedTargetingRule(env, flagId)).returning(),
          db.delete(flagConfigs).where(scopedFlagConfig(env, flagId)).returning(),
        ];
      }),
      db.delete(variants).where(eq(variants.flagId, flagId)).returning(),
      db
        .delete(flags)
        .where(and(eq(flags.appId, scope.appId), eq(flags.id, flagId)))
        .returning(),
    ];
    await db.batch(batch as unknown as Parameters<Db["batch"]>[0]);
    return true;
  };
}

type FlagInScope = (
  scope: TenantScope,
  flagId: string,
) => Promise<typeof flags.$inferSelect | null>;

function makeVariantOps(db: Db, flagInScope: FlagInScope) {
  async function variantByName(scope: TenantScope, flagId: string, name: string) {
    const flag = await flagInScope(scope, flagId);
    if (!flag) return null;
    const rows = await db
      .select()
      .from(variants)
      .where(and(eq(variants.flagId, flagId), eq(variants.name, name)))
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    async listVariants(
      scope: TenantScope,
      flagId: string,
    ): Promise<(typeof variants.$inferSelect)[]> {
      const flag = await flagInScope(scope, flagId);
      if (!flag) return [];
      return db.select().from(variants).where(eq(variants.flagId, flagId));
    },

    async addVariant(
      scope: TenantScope,
      flagId: string,
      values: Omit<typeof variants.$inferInsert, "flagId">,
    ): Promise<typeof variants.$inferSelect> {
      const flag = await flagInScope(scope, flagId);
      if (!flag) throw new Error("addVariant: flag is not in this App scope");
      const rows = await db
        .insert(variants)
        .values({ ...values, flagId })
        .returning();
      const inserted = rows[0];
      if (!inserted) throw new Error("addVariant: no row returned");
      return inserted;
    },

    getVariantByName: variantByName,

    async updateVariant(
      scope: TenantScope,
      flagId: string,
      name: string,
      patch: Partial<Pick<typeof variants.$inferInsert, "name" | "value" | "description">>,
    ): Promise<typeof variants.$inferSelect | null> {
      const variant = await variantByName(scope, flagId, name);
      if (!variant) return null;
      const rows = await db
        .update(variants)
        .set(patch)
        .where(eq(variants.id, variant.id))
        .returning();
      return rows[0] ?? null;
    },

    async removeVariant(scope: TenantScope, flagId: string, name: string): Promise<number> {
      const variant = await variantByName(scope, flagId, name);
      if (!variant) return 0;
      const rows = await db.delete(variants).where(eq(variants.id, variant.id)).returning();
      return rows.length;
    },

    async removeVariantsForFlag(scope: TenantScope, flagId: string): Promise<number> {
      const flag = await flagInScope(scope, flagId);
      if (!flag) return 0;
      const rows = await db.delete(variants).where(eq(variants.flagId, flagId)).returning();
      return rows.length;
    },
  };
}
