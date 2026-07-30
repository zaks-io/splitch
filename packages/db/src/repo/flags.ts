import { and, desc, eq, inArray } from "drizzle-orm";
import { flagConfigs, flags, segments, targetingRules, variants } from "../schema/index";
import type { Db } from "./client";
import { makeFlagConfigOps, scopedFlagConfig, scopedTargetingRule } from "./flag-config-ops";
import { type FlagInScope, makeVariantOps } from "./flag-variant-ops";
import { idBatches } from "./id-batches";
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

    ...makeVariantOps(db, flagsTable, flagInScope),

    ...makeFlagConfigOps(db, flagConfigsTable, targetingRulesTable),

    /**
     * One bounded page of the App's Flag catalog, newest first.
     *
     * Exists so the Flag list costs what it renders rather than what the App has
     * accumulated. It is also the surface the Overview's truncation notice sends
     * an operator to, so the App most likely to reach it is exactly the App whose
     * catalog is large — an unbounded read here would move the problem, not fix it.
     *
     * Ordered by `(created_at DESC, id DESC)`. `created_at` is fixed-width
     * ISO-8601 TEXT, so the lexicographic comparison SQLite applies IS the
     * chronological one. `id` is the table's PRIMARY KEY, which makes the pair a
     * TOTAL order: Flags created in one seeded or scripted batch share a
     * `created_at`, and without the tiebreaker which of the tied rows the `LIMIT`
     * dropped would vary between two otherwise identical reads.
     *
     * Ask for one row more than you intend to keep and you learn whether you
     * truncated, rather than inferring it from a full page.
     */
    listFlagPage(scope: TenantScope, limit: number) {
      return flagsTable.findMany(scope, undefined, {
        limit,
        orderBy: [desc(flags.createdAt), desc(flags.id)],
      });
    },

    /**
     * App-scoped Flag fetch by a set of IDs, for callers that already hold a
     * bounded set of `flag_id`s and only need to resolve them to keys and names.
     * Reading the App's whole Flag catalog to build that lookup makes the caller's
     * cost scale with the App instead of with its own bound.
     *
     * Batched because D1 caps bound parameters per statement; see `idBatches`.
     */
    async listFlagsByIds(scope: TenantScope, ids: readonly string[]) {
      if (ids.length === 0) return [] as (typeof flags.$inferSelect)[];
      const pages = await Promise.all(
        idBatches(ids).map((batch) => flagsTable.findMany(scope, inArray(flags.id, [...batch]))),
      );
      return pages.flat();
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
