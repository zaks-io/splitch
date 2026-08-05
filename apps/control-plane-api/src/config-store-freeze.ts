import type {
  ApplyApprovedFlagConfigInput,
  ConfigStoreDeps,
  PatchFlagConfigInput,
  PromoteFlagConfigInput,
  ReplaceTargetingRulesInput,
} from "./config-store-types";
import {
  frozenConfigFields,
  frozenPromotionFields,
  frozenTargetingFields,
  frozenWriteFailure,
  type RunFrozenFailure,
} from "./flag-config-run-freeze";
import { frozenFieldsFromDiffEntries } from "./flag-config-run-freeze-proposal";

/**
 * One freeze check per KIND of Flag Configuration write, sitting where the write
 * does rather than on the routes that happen to reach it.
 *
 * SPL-118 shipped the guard at the route layer for the Configuration PATCH and
 * the Targeting PUT only, and two other doors — the Promotion POST and an
 * `approve_and_apply` Review of a proposal that predates the Run — walked
 * straight past it into the same `flag_configs` / `targeting_rules` rows. Adding a
 * third and fourth route call would have left the fifth door open. These helpers
 * are called by the store methods themselves, so a writer is guarded because of
 * where it lives, and the sweep in `flag-config-run-freeze-writer-sweep.test.ts`
 * fails the moment a store method is added without being classified.
 */

export function configPatchFreeze(
  deps: ConfigStoreDeps,
  input: PatchFlagConfigInput,
): Promise<RunFrozenFailure | null> {
  return frozenWriteFailure(
    deps.repo,
    { appId: input.appId, environmentId: input.environmentId, flagId: input.flagId },
    frozenConfigFields(input),
    "PATCH_FLAG_CONFIG",
  );
}

export function targetingFreeze(
  deps: ConfigStoreDeps,
  input: ReplaceTargetingRulesInput,
): Promise<RunFrozenFailure | null> {
  return frozenWriteFailure(
    deps.repo,
    { appId: input.appId, environmentId: input.environmentId, flagId: input.flagId },
    frozenTargetingFields(),
    "PUT_TARGETING_RULES",
  );
}

/** A Promotion writes into the TARGET Environment, so the target's Run judges it. */
export function promotionFreeze(
  deps: ConfigStoreDeps,
  input: PromoteFlagConfigInput,
): Promise<RunFrozenFailure | null> {
  return frozenWriteFailure(
    deps.repo,
    {
      appId: input.appId,
      environmentId: input.targetEnvironmentId,
      flagId: input.flagId,
    },
    frozenPromotionFields(input.select),
    "PROMOTE_FLAG_CONFIG",
  );
}

/**
 * An approved proposal is judged by the request's own changed-field set
 * (`diff.entries`), not by re-diffing the complete proposed snapshot against
 * live state. The latter is what falsely reported `flagConfig.targetingRules`
 * for an `/enabled`-only request (SPL-304).
 *
 * When the changed-field set cannot be determined, refuse rather than apply —
 * including when no Run is live — so a corrupt proposal never lands as a write.
 */
export async function approvedProposalFreeze(
  deps: ConfigStoreDeps,
  input: ApplyApprovedFlagConfigInput,
): Promise<RunFrozenFailure | { ok: false; reason: "CHANGED_FIELDS_UNDETERMINED" } | null> {
  const changed = frozenFieldsFromDiffEntries(input.diffEntries);
  if (!changed.ok) {
    return { ok: false, reason: "CHANGED_FIELDS_UNDETERMINED" };
  }
  return frozenWriteFailure(
    deps.repo,
    { appId: input.appId, environmentId: input.environmentId, flagId: input.flagId },
    changed.frozenFields,
    "APPLY_APPROVED_FLAG_CONFIG",
  );
}
