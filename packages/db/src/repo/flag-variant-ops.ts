import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { flags, targetingRules, variants } from "../schema/index";
import { approvalPendingCondition, approvalReviewLanded } from "./approval-atomic";
import type { Db } from "./client";
import {
  catalogApprovalBatch,
  guardedVariantInsert,
  makeUpdateVariant,
  type VariantWriteOptions,
} from "./flag-variant-approval";
import {
  type FlagInScope,
  makeEnsureCreateVariant,
  makeEnsureCreateVariants,
  variantsInInsertOrder,
} from "./flag-variant-create";
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
 * through the App-scoped `flags` facade, either as a preceding read or as a
 * subquery inside the catalog statement itself. That proof is the tenant
 * boundary for the catalog (ADR-0018), so no operation in this file may skip
 * it — batched reads included.
 */
export type { FlagInScope } from "./flag-variant-create";

export type TargetingRuleVariantRef = {
  id: string;
  environmentId: string;
};

/**
 * The Variant delete as a RESULT, not a deleted-row count.
 *
 * `targeting_rules.variant_id` has no SQLite FK (schema/flags.ts), so a count
 * of 0 used to mean both "deleted" and "a concurrent Targeting Rule landed
 * between the preflight and this write". Those must stay DISTINCT: the
 * predicate lives on the DELETE itself, and a live reference is a typed
 * refusal rather than a silent no-op (ADR-0036).
 */
export type RemoveVariantResult =
  | { ok: true }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "NOT_APPLIED" }
  | {
      ok: false;
      reason: "TARGETING_RULE_REFS";
      variantName: string;
      targetingRules: TargetingRuleVariantRef[];
    };

/**
 * The write-time predicate: refuse the delete when any Targeting Rule in this
 * App still names the Variant. A preceding list is fail-fast only — this is
 * the statement that actually preserves the invariant.
 */
function noTargetingRuleReferences(db: Db, scope: TenantScope, variantId: string) {
  return notExists(
    db
      .select({ one: sql<number>`1` })
      .from(targetingRules)
      .where(and(eq(targetingRules.appId, scope.appId), eq(targetingRules.variantId, variantId))),
  );
}

async function listTargetingRuleRefs(
  db: Db,
  scope: TenantScope,
  variantId: string,
): Promise<TargetingRuleVariantRef[]> {
  const rows = await db
    .select({
      id: targetingRules.id,
      environmentId: targetingRules.environmentId,
    })
    .from(targetingRules)
    .where(and(eq(targetingRules.appId, scope.appId), eq(targetingRules.variantId, variantId)));
  return rows.sort((left, right) => {
    const byEnv = left.environmentId.localeCompare(right.environmentId);
    return byEnv !== 0 ? byEnv : left.id.localeCompare(right.id);
  });
}

async function targetingRefsOrNotApplied(
  db: Db,
  scope: TenantScope,
  variant: { id: string; name: string },
): Promise<Exclude<RemoveVariantResult, { ok: true }>> {
  const targetingRulesForVariant = await listTargetingRuleRefs(db, scope, variant.id);
  return targetingRulesForVariant.length > 0
    ? {
        ok: false,
        reason: "TARGETING_RULE_REFS",
        variantName: variant.name,
        targetingRules: targetingRulesForVariant,
      }
    : { ok: false, reason: "NOT_APPLIED" };
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
    variant: { id: string; name: string };
    options: VariantWriteOptions;
    reread: () => Promise<unknown>;
  },
): Promise<RemoveVariantResult> {
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
            eq(variants.id, input.variant.id),
            approvalPendingCondition(db, input.scope, approval),
            noTargetingRuleReferences(db, input.scope, input.variant.id),
          ),
        )
        .returning(),
      options: input.options,
    }),
  );
  if (await approvalReviewLanded(db, input.scope, approval)) {
    return (await input.reread()) ? { ok: false, reason: "NOT_APPLIED" } : { ok: true };
  }
  return targetingRefsOrNotApplied(db, input.scope, input.variant);
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
     * per row; this makes it cost one, whatever the page size.
     *
     * The tenant boundary is IDENTICAL to `listVariants` and batching does not
     * weaken it: every requested id is re-proved against the App-scoped `flags`
     * facade and the catalog read is restricted to the survivors. Trusting the
     * caller's ids because they "came from a scoped read" would move the
     * boundary out of the seam, which is the one place it is allowed to live
     * (ADR-0018).
     *
     * Read-only, so it takes no `VariantWriteOptions`: an Approval guards a
     * mutation, and there is nothing here for a Review to land on.
     *
     * Batched because D1 caps bound parameters per statement; see `idBatches`.
     *
     * The proof is a SUBQUERY, not a preceding read: resolving the in-scope ids
     * first and then filtering on them is two sequential D1 round trips for one
     * logical read, and the round trip -- not the query -- is what this endpoint
     * pays for. `idsInScope` emits the same mandatory scope predicate, so an
     * out-of-scope Flag id still selects nothing.
     */
    async listVariantsForFlags(
      scope: TenantScope,
      flagIds: readonly string[],
    ): Promise<Map<string, (typeof variants.$inferSelect)[]>> {
      const byFlag = new Map<string, (typeof variants.$inferSelect)[]>();
      if (flagIds.length === 0) return byFlag;

      const rows = (
        await Promise.all(
          idBatches(flagIds).map((batch) =>
            variantsInInsertOrder(
              db,
              inArray(variants.flagId, flagsTable.idsInScope(scope, inArray(flags.id, [...batch]))),
            ),
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

    /**
     * Idempotent create-time catalog provisioning in a single D1 batch. The
     * read-before/write/read shape preserves retry and race behavior without a
     * separate scope lookup and insert round trip for every Variant.
     */
    ensureCreateVariants: makeEnsureCreateVariants(db, flagInScope),

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
    ): Promise<RemoveVariantResult> {
      const variant = await variantByName(scope, flagId, name);
      const flag = await flagInScope(scope, flagId);
      if (!(variant && flag)) return { ok: false, reason: "NOT_FOUND" };
      if (options?.approval) {
        return approvedVariantDelete(db, {
          scope,
          flag,
          variant,
          options,
          reread: () => variantByName(scope, flagId, name),
        });
      }
      // One-statement batch so the write-time predicate and the delete are the
      // same D1 transaction a concurrent Targeting Rule replace cannot split,
      // and so a test can land that replace strictly between the reads above
      // and this mutation — the same hook `updateVariant` already uses.
      const mutation = db
        .delete(variants)
        .where(and(eq(variants.id, variant.id), noTargetingRuleReferences(db, scope, variant.id)))
        .returning();
      await db.batch([mutation] as unknown as Parameters<Db["batch"]>[0]);
      return (await variantByName(scope, flagId, name))
        ? targetingRefsOrNotApplied(db, scope, variant)
        : { ok: true };
    },

    async removeVariantsForFlag(scope: TenantScope, flagId: string): Promise<number> {
      const flag = await flagInScope(scope, flagId);
      if (!flag) return 0;
      const rows = await db.delete(variants).where(eq(variants.flagId, flagId)).returning();
      return rows.length;
    },
  };
}
