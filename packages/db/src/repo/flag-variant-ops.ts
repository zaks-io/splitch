import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { flags, variants } from "../schema/index";
import { approvalPendingCondition, approvalReviewLanded } from "./approval-atomic";
import type { Db } from "./client";
import {
  catalogApprovalBatch,
  guardedVariantInsert,
  makeUpdateVariant,
  type VariantWriteOptions,
} from "./flag-variant-approval";
import {
  liveRunUsingVariant,
  type VariantIdentity,
  type VariantRunFreeze,
} from "./flag-variant-run-freeze";
import { idBatches } from "./id-batches";
import type { TenantScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

/**
 * `variants` is the one table in the domain with no `app_id` column: a Variant is
 * reached transitively through its parent Flag (`flag_id` -> `flags.app_id`).
 * Every operation here therefore proves the Flag is in the caller's App scope
 * FIRST, through the App-scoped `flags` facade, and only then touches the
 * catalog. That proof is the tenant boundary for the catalog (ADR-0018), so no
 * operation in this file may skip it — batched reads included.
 */
export type FlagInScope = (
  scope: TenantScope,
  flagId: string,
) => Promise<typeof flags.$inferSelect | null>;

type VariantByName = (
  scope: TenantScope,
  flagId: string,
  name: string,
) => Promise<typeof variants.$inferSelect | null>;

function variantsInInsertOrder(db: Db, predicate: SQL<unknown>) {
  return db
    .select()
    .from(variants)
    .where(predicate)
    .orderBy(asc(sql`${variants}.rowid`));
}

async function insertCreateVariantOrWinner(
  db: Db,
  variantByName: VariantByName,
  scope: TenantScope,
  flagId: string,
  values: Omit<typeof variants.$inferInsert, "flagId">,
): Promise<typeof variants.$inferSelect> {
  try {
    const rows = await db
      .insert(variants)
      .values({ ...values, flagId })
      .returning();
    const inserted = rows[0];
    if (!inserted) throw new Error("ensureCreateVariant: no row returned");
    return inserted;
  } catch (cause) {
    const winner = await variantByName(scope, flagId, values.name);
    if (winner) return winner;
    throw cause;
  }
}

function makeEnsureCreateVariant(db: Db, flagInScope: FlagInScope, variantByName: VariantByName) {
  return async function ensureCreateVariant(
    scope: TenantScope,
    flagId: string,
    values: Omit<typeof variants.$inferInsert, "flagId">,
  ): Promise<typeof variants.$inferSelect> {
    const flag = await flagInScope(scope, flagId);
    if (!flag) throw new Error("ensureCreateVariant: flag is not in this App scope");
    const existing = await variantByName(scope, flagId, values.name);
    if (existing) return existing;
    return insertCreateVariantOrWinner(db, variantByName, scope, flagId, values);
  };
}

/**
 * The Approval-guarded delete, its landing check, and the confirming re-read.
 * A lost guard leaves every statement in the batch a no-op, so without the
 * landing check the re-read would report an unrelated absence as this
 * proposal's delete.
 */
async function approvedVariantDelete(
  db: Db,
  input: {
    scope: TenantScope;
    flag: typeof flags.$inferSelect;
    variantId: string;
    options: VariantWriteOptions;
    reread: () => Promise<unknown>;
  },
): Promise<number> {
  const approval = input.options.approval;
  if (!approval) throw new Error("approvedVariantDelete: an Approval commit is required");
  await db.batch(
    catalogApprovalBatch(db, {
      scope: input.scope,
      flag: input.flag,
      mutation: db
        .delete(variants)
        .where(
          and(
            eq(variants.id, input.variantId),
            approvalPendingCondition(db, input.scope, approval),
          ),
        )
        .returning(),
      options: input.options,
    }),
  );
  if (!(await approvalReviewLanded(db, input.scope, approval))) return 0;
  return (await input.reread()) ? 0 : 1;
}

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
      return variantsInInsertOrder(db, eq(variants.flagId, flagId));
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
     * Read-only, so it takes no `VariantWriteOptions`: an Approval guards a
     * mutation, and there is nothing here for a Review to land on.
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
            variantsInInsertOrder(db, inArray(variants.flagId, batch)),
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
      options?: VariantWriteOptions,
    ): Promise<typeof variants.$inferSelect | null> {
      const flag = await flagInScope(scope, flagId);
      if (!flag) throw new Error("addVariant: flag is not in this App scope");
      if (options?.approval) {
        await db.batch(
          catalogApprovalBatch(db, {
            scope,
            flag,
            mutation: guardedVariantInsert(db, scope, { ...values, flagId }, options.approval),
            options,
          }),
        );
        // A lost guard leaves every statement a no-op; the re-read would then
        // report some pre-existing row as this proposal's creation.
        if (!(await approvalReviewLanded(db, scope, options.approval))) return null;
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

    /** Concurrent create retries converge on the row chosen by the database. */
    ensureCreateVariant: makeEnsureCreateVariant(db, flagInScope, variantByName),

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

    /**
     * The one freeze predicate, exposed so the route layer can fail fast on the
     * same answer `updateVariant` enforces instead of keeping a second copy.
     * Reading it is never permission to write: `updateVariant` re-checks.
     */
    liveRunUsingVariant(
      scope: TenantScope,
      flagId: string,
      variant: VariantIdentity,
    ): Promise<VariantRunFreeze | null> {
      return liveRunUsingVariant(db, scope, flagId, variant);
    },

    async removeVariant(
      scope: TenantScope,
      flagId: string,
      name: string,
      options?: VariantWriteOptions,
    ): Promise<number> {
      const variant = await variantByName(scope, flagId, name);
      const flag = await flagInScope(scope, flagId);
      if (!(variant && flag)) return 0;
      if (options?.approval) {
        return approvedVariantDelete(db, {
          scope,
          flag,
          variantId: variant.id,
          options,
          reread: () => variantByName(scope, flagId, name),
        });
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
