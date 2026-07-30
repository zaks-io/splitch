import { and, eq } from "drizzle-orm";
import { flags, variants } from "../schema/index";
import { approvalPendingCondition } from "./approval-atomic";
import type { Db } from "./client";
import {
  catalogApprovalBatch,
  guardedVariantInsert,
  makeUpdateVariant,
  type VariantWriteOptions,
} from "./flag-variant-approval";
import type { TenantScope } from "./scope";

export type FlagInScope = (
  scope: TenantScope,
  flagId: string,
) => Promise<typeof flags.$inferSelect | null>;

export function makeVariantOps(db: Db, flagInScope: FlagInScope) {
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
      options?: VariantWriteOptions,
    ): Promise<typeof variants.$inferSelect | null> {
      const flag = await flagInScope(scope, flagId);
      if (!flag) throw new Error("addVariant: flag is not in this App scope");
      if (options?.approval) {
        await db.batch(
          catalogApprovalBatch(db, {
            scope,
            flag,
            mutation: guardedVariantInsert(db, { ...values, flagId }, options.approval),
            options,
          }),
        );
        return variantByName(scope, flagId, values.name);
      }
      const rows = await db
        .insert(variants)
        .values({ ...values, flagId })
        .returning();
      const inserted = rows[0];
      if (!inserted) throw new Error("addVariant: no row returned");
      return inserted;
    },

    getVariantByName: variantByName,

    async getVariantById(scope: TenantScope, variantId: string) {
      const rows = await db
        .select({
          id: variants.id,
          flagId: variants.flagId,
          name: variants.name,
          value: variants.value,
          description: variants.description,
          createdAt: variants.createdAt,
        })
        .from(variants)
        .innerJoin(flags, eq(flags.id, variants.flagId))
        .where(and(eq(flags.appId, scope.appId), eq(variants.id, variantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    updateVariant: makeUpdateVariant(db, flagInScope, variantByName),

    async removeVariant(
      scope: TenantScope,
      flagId: string,
      name: string,
      options?: VariantWriteOptions,
    ): Promise<number> {
      const variant = await variantByName(scope, flagId, name);
      if (!variant) return 0;
      const flag = await flagInScope(scope, flagId);
      if (!flag) return 0;
      if (options?.approval) {
        await db.batch(
          catalogApprovalBatch(db, {
            scope,
            flag,
            mutation: db
              .delete(variants)
              .where(
                and(eq(variants.id, variant.id), approvalPendingCondition(db, options.approval)),
              )
              .returning(),
            options,
          }),
        );
        return (await variantByName(scope, flagId, name)) ? 0 : 1;
      }
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
