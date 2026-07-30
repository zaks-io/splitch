import { and, eq, inArray } from "drizzle-orm";
import { flags, variants } from "../schema/index";
import type { Db } from "./client";
import { idBatches } from "./id-batches";
import type { TenantScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

/**
 * App-level Variant CATALOG reads and writes, split out of `makeFlagRepo` so the
 * flag repo stays readable as the catalog surface grows.
 *
 * `variants` is the one table in the domain with no `app_id` column: a Variant is
 * reached transitively through its parent Flag (`flag_id` -> `flags.app_id`).
 * Every operation here therefore proves the Flag is in the caller's App scope
 * FIRST, through the App-scoped `flags` facade, and only then touches the
 * catalog. That proof is the tenant boundary for the catalog (ADR-0018), so no
 * operation in this file may skip it.
 */
export type FlagInScope = (
  scope: TenantScope,
  flagId: string,
) => Promise<typeof flags.$inferSelect | null>;

export function makeVariantOps(
  db: Db,
  flagsTable: ScopedTable<typeof flags>,
  flagInScope: FlagInScope,
) {
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

    /**
     * Variant catalogs for a set of Flags, grouped by `flag_id`, in ONE read.
     *
     * Calling `listVariants` per Flag is what makes a Flag LIST cost a D1 read
     * per row; this makes it cost a fixed two, whatever the page size.
     *
     * The tenant boundary is IDENTICAL to `listVariants` and batching does not
     * weaken it: every requested id is re-proved against the App-scoped `flags`
     * facade and the catalog read is restricted to the survivors. Trusting the
     * caller's ids because they "came from a scoped read" would move the boundary
     * out of the seam, which is the one place it is allowed to live (ADR-0018).
     *
     * Batched because D1 caps bound parameters per statement; see `idBatches`.
     */
    async listVariantsForFlags(
      scope: TenantScope,
      flagIds: readonly string[],
    ): Promise<Map<string, (typeof variants.$inferSelect)[]>> {
      const byFlag = new Map<string, (typeof variants.$inferSelect)[]>();
      if (flagIds.length === 0) return byFlag;

      const scoped = (
        await Promise.all(
          idBatches(flagIds).map((batch) =>
            flagsTable.findMany(scope, inArray(flags.id, [...batch])),
          ),
        )
      ).flat();
      if (scoped.length === 0) return byFlag;

      const scopedIds = scoped.map((flag) => flag.id);
      const rows = (
        await Promise.all(
          idBatches(scopedIds).map((batch) =>
            db.select().from(variants).where(inArray(variants.flagId, batch)),
          ),
        )
      ).flat();
      for (const row of rows) {
        const existing = byFlag.get(row.flagId);
        if (existing) existing.push(row);
        else byFlag.set(row.flagId, [row]);
      }
      return byFlag;
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
