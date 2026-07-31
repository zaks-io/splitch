import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { approvalRequests, environments, flagConfigs, flags, variants } from "../schema/index";
import {
  appliedRequestUpdate,
  appliedReviewInsert,
  approvalPendingCondition,
  approvalReviewLanded,
  reviewRecorded,
} from "./approval-atomic";
import type { ApprovalCommit } from "./approval-types";
import type { Db } from "./client";
import { liveRunUsingVariant, type VariantRunFreeze } from "./flag-variant-run-freeze";
import { assertMintedScope, type TenantScope } from "./scope";

/**
 * Carry a Variant rename into every Environment's available set for the Flag,
 * order preserved, in the same statement batch as the rename itself. When the
 * rename was authorized by an Approval Review, the rewrite is guarded by that
 * Review row so it can never land without it.
 *
 * The `version` bump is load-bearing, not bookkeeping: it is what makes a
 * pending flag_configuration proposal for the same row render `stale` and what
 * lets `updateFlagConfig`'s optimistic version guard see this write at all.
 *
 * EVERY Environment is deliberate, not an oversight: the Variant catalog is
 * App-level (ADR-0028) and the name is one shared value, so a rename that
 * reached only some Environments would leave the rest naming a Variant that no
 * longer exists. What the Environment axis buys here (ADR-0027) is a BOUND: the
 * rewrite is restricted to `environment_id`s that belong to this App, so an
 * Environment row that has been removed, or a `flag_configs` row whose
 * `environment_id` has drifted out of the App, is not silently rewritten and
 * version-bumped. `app_id` is the tenant boundary (ADR-0018) and is unchanged.
 *
 * This function is module-private ON PURPOSE. Its only caller is
 * `makeUpdateVariant` below, which refuses the rename when a live Run owns the
 * name; exporting it would create a door around that refusal.
 */
function renameAvailableVariant(
  db: Db,
  scope: TenantScope,
  flagId: string,
  from: string,
  to: string,
  options: { approval?: ApprovalCommit; updatedAt?: string },
) {
  assertMintedScope(scope);
  const approval = options.approval;
  return db
    .update(flagConfigs)
    .set({
      availableVariantNames: sql`(SELECT json_group_array(CASE WHEN "value" = ${from} THEN ${to} ELSE "value" END) FROM json_each(${flagConfigs.availableVariantNames}))`,
      version: sql`${flagConfigs.version} + 1`,
      ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
    })
    .where(
      and(
        eq(flagConfigs.appId, scope.appId),
        eq(flagConfigs.flagId, flagId),
        inArray(
          flagConfigs.environmentId,
          db
            .select({ id: environments.id })
            .from(environments)
            .where(eq(environments.appId, scope.appId)),
        ),
        sql`EXISTS (SELECT 1 FROM json_each(${flagConfigs.availableVariantNames}) WHERE "value" = ${from})`,
        ...(approval ? [reviewRecorded(db, scope, approval)] : []),
      ),
    )
    .returning({ id: flagConfigs.id });
}

export interface VariantWriteOptions {
  updatedAt?: string;
  updatedBy?: string;
  approval?: ApprovalCommit;
}

/**
 * An INSERT that lands only if this Review's Approval Request is still pending
 * under the Policy it was proposed against. Drizzle has no `INSERT ... WHERE`,
 * so the row is selected out of the guarding `approval_requests` row itself:
 * zero rows selected means zero rows inserted.
 */
export function guardedVariantInsert(
  db: Db,
  scope: TenantScope,
  values: typeof variants.$inferInsert,
  approval: ApprovalCommit,
) {
  return db.insert(variants).select(
    db
      .select({
        id: sql<string>`${values.id}`.as("id"),
        flagId: sql<string>`${values.flagId}`.as("flag_id"),
        name: sql<string>`${values.name}`.as("name"),
        value: sql<string>`${values.value}`.as("value"),
        description: sql<string | null>`${values.description ?? null}`.as("description"),
        createdAt: sql<string>`${values.createdAt}`.as("created_at"),
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.appId, scope.appId),
          eq(approvalRequests.id, approval.requestId),
          approvalPendingCondition(db, scope, approval),
        ),
      ),
  );
}

/**
 * Catalog membership (add / remove a Variant) changes what an Environment can
 * serve, so the parent Flag version bump, the Review row, and the request
 * resolution ride in the same batch as the mutation, guarded the same way the
 * Variant update path is.
 */
export function catalogApprovalBatch(
  db: Db,
  args: {
    scope: TenantScope;
    flag: typeof flags.$inferSelect;
    mutation: unknown;
    options: VariantWriteOptions;
  },
) {
  const approval = args.options.approval;
  if (!approval) throw new Error("catalogApprovalBatch: an Approval commit is required");
  const flagUpdate = db
    .update(flags)
    .set({
      version: args.flag.version + 1,
      updatedAt: approval.reviewedAt,
      updatedBy: args.options.updatedBy ?? args.flag.updatedBy,
    })
    .where(
      and(
        eq(flags.appId, args.scope.appId),
        eq(flags.id, args.flag.id),
        eq(flags.version, args.flag.version),
        approvalPendingCondition(db, args.scope, approval),
        sql`changes() = 1`,
      ),
    )
    .returning();
  return [
    args.mutation,
    flagUpdate,
    appliedReviewInsert(db, args.scope, approval),
    appliedRequestUpdate(db, args.scope, approval),
  ] as unknown as Parameters<Db["batch"]>[0];
}

/**
 * The parent Flag is still at the version this write was planned against.
 *
 * `variants` has no `version` column of its own, so the Flag version IS the
 * concurrency token for the catalog. The sibling `flags` bump in the same batch
 * carries the CAS, but a CAS on a LATER statement cannot un-commit an EARLIER
 * one: without this the Variant row mutates, the version bump silently loses,
 * and the caller is told the change did not apply. Binding the CAS to the
 * Variant mutation itself makes the whole batch collapse together, exactly the
 * way `flag-config-ops` puts the config version CAS on its own mutation.
 */
function flagVersionUnchanged(db: Db, scope: TenantScope, flagId: string, version: number) {
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(flags)
      .where(and(eq(flags.appId, scope.appId), eq(flags.id, flagId), eq(flags.version, version))),
  );
}

type VariantByName = (
  scope: TenantScope,
  flagId: string,
  name: string,
) => Promise<typeof variants.$inferSelect | null>;

/**
 * The Variant update as a RESULT, not a nullable row.
 *
 * `RUN_FROZEN` is a member of this union rather than a thrown error or a `null`
 * so a caller that forgets the refusal fails to COMPILE — the same move SPL-118
 * made when it added `RunFrozenFailure` to `FlagConfigWriteFailure`. `null` used
 * to mean both "no such Variant" and "the Approval-guarded write landed
 * nothing", which is exactly the ambiguity a refusal must not join.
 */
export type UpdateVariantResult =
  | { ok: true; variant: typeof variants.$inferSelect }
  /** No Variant by that name, or the Flag is not in this App scope. */
  | { ok: false; reason: "NOT_FOUND" }
  /** The Approval-guarded write selected zero rows; no Review landed. */
  | { ok: false; reason: "NOT_APPLIED" }
  | { ok: false; reason: "RUN_FROZEN"; freeze: VariantRunFreeze; variantName: string };

export function makeUpdateVariant(
  db: Db,
  flagInScope: (scope: TenantScope, flagId: string) => Promise<typeof flags.$inferSelect | null>,
  variantByName: VariantByName,
) {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the guarded Variant and parent Flag writes form one atomic Approval batch
  return async function updateVariant(
    scope: TenantScope,
    flagId: string,
    name: string,
    patch: Partial<Pick<typeof variants.$inferInsert, "name" | "value" | "description">>,
    options?: {
      updatedAt?: string;
      updatedBy?: string;
      approval?: ApprovalCommit;
    },
  ): Promise<UpdateVariantResult> {
    const variant = await variantByName(scope, flagId, name);
    if (!variant) return { ok: false, reason: "NOT_FOUND" };
    const flag = await flagInScope(scope, flagId);
    if (!flag) return { ok: false, reason: "NOT_FOUND" };

    const renaming = patch.name !== undefined && patch.name !== variant.name;
    // The refusal sits AHEAD of the batch, not inside it: a rename that a live
    // Run forbids must leave no Review row, no version bump, and no partially
    // applied Approval Request behind.
    if (renaming) {
      const freeze = await liveRunUsingVariant(db, scope, flagId, variant);
      if (freeze) return { ok: false, reason: "RUN_FROZEN", freeze, variantName: variant.name };
    }
    const variantWhere = options?.approval
      ? and(
          eq(variants.id, variant.id),
          approvalPendingCondition(db, scope, options.approval),
          flagVersionUnchanged(db, scope, flagId, flag.version),
        )
      : eq(variants.id, variant.id);
    const variantUpdate = db.update(variants).set(patch).where(variantWhere).returning();
    const flagUpdate = db
      .update(flags)
      .set({
        version: flag.version + 1,
        updatedAt: options?.approval?.reviewedAt ?? options?.updatedAt ?? flag.updatedAt,
        updatedBy: options?.updatedBy ?? flag.updatedBy,
      })
      .where(
        and(
          eq(flags.appId, scope.appId),
          eq(flags.id, flagId),
          eq(flags.version, flag.version),
          ...(options?.approval
            ? [approvalPendingCondition(db, scope, options.approval), sql`changes() = 1`]
            : []),
        ),
      )
      .returning();
    // `changes() = 1` binds the Review to the flag version bump immediately
    // above it; a value probe could be satisfied by a concurrent Review of a
    // different request committing in the same millisecond.
    const reviewInsert = options?.approval
      ? [appliedReviewInsert(db, scope, options.approval)]
      : [];
    const requestUpdate = options?.approval
      ? [appliedRequestUpdate(db, scope, options.approval)]
      : [];
    // A rename must carry `flag_configs.available_variant_names` with it in the
    // same transaction. Otherwise every Environment keeps pointing at a Variant
    // name that no longer exists: the served snapshot dangles and the Variant
    // stops counting as servable, which silently disarms the Approval gate on
    // any follow-up value edit.
    const renameQueries = renaming
      ? [
          renameAvailableVariant(db, scope, flagId, variant.name, patch.name as string, {
            approval: options?.approval,
            updatedAt: options?.approval?.reviewedAt ?? options?.updatedAt,
          }),
        ]
      : [];
    await db.batch([
      variantUpdate,
      flagUpdate,
      ...reviewInsert,
      ...renameQueries,
      ...requestUpdate,
    ] as unknown as Parameters<Db["batch"]>[0]);
    // A lost guard no-ops the whole batch, and the re-read below would then hand
    // back the untouched Variant as though the proposal had been applied.
    if (options?.approval && !(await approvalReviewLanded(db, scope, options.approval)))
      return { ok: false, reason: "NOT_APPLIED" };
    const updated = await variantByName(scope, flagId, (patch.name as string | undefined) ?? name);
    return updated ? { ok: true, variant: updated } : { ok: false, reason: "NOT_APPLIED" };
  };
}
