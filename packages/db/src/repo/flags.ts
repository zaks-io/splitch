import { and, eq, inArray } from "drizzle-orm";
import { flagConfigs, flags, segments, targetingRules, variants } from "../schema/index";
import type { Db } from "./client";
import type { EnvScope, TenantScope } from "./scope";
import { assertMintedScope } from "./scope";
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

    ...makeVariantOps(db, flagInScope),

    getFlagConfig(scope: EnvScope, flagId: string) {
      return flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
    },

    async updateFlagConfig(
      scope: EnvScope,
      flagId: string,
      patch: Partial<
        Pick<
          typeof flagConfigs.$inferInsert,
          "enabled" | "availableVariantNames" | "defaultVariantId" | "updatedAt" | "version"
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
        Pick<typeof flagConfigs.$inferInsert, "enabled" | "availableVariantNames" | "updatedAt">
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

function scopedTargetingRule(scope: EnvScope, flagId: string) {
  return and(
    eq(targetingRules.appId, scope.appId),
    eq(targetingRules.environmentId, scope.environmentId),
    eq(targetingRules.flagId, flagId),
  );
}

function scopedFlagConfig(scope: EnvScope, flagId: string) {
  return and(
    eq(flagConfigs.appId, scope.appId),
    eq(flagConfigs.environmentId, scope.environmentId),
    eq(flagConfigs.flagId, flagId),
  );
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
