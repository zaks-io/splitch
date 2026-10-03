import { and, eq, inArray } from "drizzle-orm";
import { experiments, flagConfigs, flags, runs, targetingRules, variants } from "../schema/index";
import {
  appliedRequestUpdate,
  appliedReviewInsert,
  approvalPendingCondition,
} from "./approval-atomic";
import type { ApprovalCommit } from "./approval-types";
import type { Db } from "./client";
import { scopedFlagConfig, scopedTargetingRule } from "./flag-config-ops";
import {
  codeRemovalClaimBatchStatements,
  type FlagDeletionCodeRemovalRecord,
} from "./flag-deletion-code-removal";
import type { FlagInScope } from "./flag-variant-ops";
import { envScope, type TenantScope } from "./scope";

/**
 * When an Approval Review authorizes the delete, EVERY statement in the
 * cascade is guarded by that Review's Request still being pending. Guarding
 * only the parent row would let a resolved or stale Request still wipe a
 * `confirm` Environment's Configurations and targeting rules — including
 * archived Experiments / Runs purged for the `flag_id` FK (same batch).
 *
 * The code-removal claim patches the AFTER DELETE audit row in this same batch.
 */
export function makeDeleteFlagCascade(db: Db, flagInScope: FlagInScope) {
  return async function deleteFlagCascade(
    scope: TenantScope,
    flagId: string,
    environmentIds: readonly string[],
    options?: { approval?: ApprovalCommit; codeRemoval?: FlagDeletionCodeRemovalRecord },
  ): Promise<boolean> {
    const flag = await flagInScope(scope, flagId);
    if (!flag) return false;

    const approval = options?.approval;
    const codeRemoval = options?.codeRemoval ?? { state: "unknown" as const };
    const pending = approval ? [approvalPendingCondition(db, scope, approval)] : [];
    const batch = [
      ...environmentIds.flatMap((environmentId) => {
        const env = envScope(scope.appId, environmentId);
        return [
          ...archivedExperimentPurgeForFlag(db, env.appId, environmentId, flagId, pending),
          db
            .delete(targetingRules)
            .where(and(scopedTargetingRule(env, flagId), ...pending))
            .returning(),
          db
            .delete(flagConfigs)
            .where(and(scopedFlagConfig(env, flagId), ...pending))
            .returning(),
        ];
      }),
      db
        .delete(variants)
        .where(and(eq(variants.flagId, flagId), ...pending))
        .returning(),
      db
        .delete(flags)
        .where(and(eq(flags.appId, scope.appId), eq(flags.id, flagId), ...pending))
        .returning(),
      // Review insert must stay immediately after Flag DELETE so changes()=1 binds.
      ...(approval
        ? [appliedReviewInsert(db, scope, approval), appliedRequestUpdate(db, scope, approval)]
        : []),
      ...codeRemovalClaimBatchStatements(db, scope, flag, codeRemoval),
    ];
    await db.batch(batch as unknown as Parameters<Db["batch"]>[0]);
    return approval ? (await flagInScope(scope, flagId)) === null : true;
  };
}

/** Runs first, then Experiments — both share the Approval pending guard. */
function archivedExperimentPurgeForFlag(
  db: Db,
  appId: string,
  environmentId: string,
  flagId: string,
  pending: ReturnType<typeof approvalPendingCondition>[],
) {
  const archivedForFlag = and(
    eq(experiments.appId, appId),
    eq(experiments.environmentId, environmentId),
    eq(experiments.flagId, flagId),
    eq(experiments.status, "archived"),
  );
  return [
    db
      .delete(runs)
      .where(
        and(
          eq(runs.appId, appId),
          eq(runs.environmentId, environmentId),
          inArray(
            runs.experimentId,
            db.select({ id: experiments.id }).from(experiments).where(archivedForFlag),
          ),
          ...pending,
        ),
      )
      .returning({ id: runs.id }),
    db
      .delete(experiments)
      .where(and(archivedForFlag, ...pending))
      .returning({ id: experiments.id }),
  ] as const;
}
