import { envScope } from "@splitch/db";
import { approvedProposalFreeze } from "./config-store-freeze";
import {
  type ApplyApprovedFlagConfigInput,
  buildSnapshotFromD1,
  type ConfigStoreRuntimeDeps,
  type FlagConfigWriteResult,
  json,
  missingAvailableVariants,
  missingRuleVariantNames,
  type Snapshot,
  targetingRuleRows,
  writeSnapshotAndBroadcast,
} from "./config-store-shared";
import { targetingRulePersistFailure } from "./config-store-targeting-rules";
import { baselineIsUnresolvable } from "./flag-config-rollout";
import { diffEntriesTouch } from "./flag-config-run-freeze-proposal";
import { resolveTargetingRules } from "./targeting-rule-resolution";

/**
 * The write an approved Approval Request performs. It is separate from the
 * direct patch path because the proposal is COMPLETE state, not a partial patch:
 * every field is validated against what the write lands, and the D1 mutation
 * carries the Review commit so a lost guard leaves the edge untouched.
 */
export async function applyApprovedFlagConfig(
  deps: ConfigStoreRuntimeDeps,
  input: ApplyApprovedFlagConfigInput,
): Promise<FlagConfigWriteResult> {
  const scope = envScope(input.appId, input.environmentId);
  const current = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!current) return { ok: false, reason: "FLAG_NOT_FOUND" };
  const invalid = await validateProposal(deps, current, input);
  if (invalid) return invalid;
  // Judged against the request's own changed-field set (`diff.entries`), not
  // against a re-diff of the complete proposed snapshot: a Run started after
  // the proposal was minted bumps no Flag Configuration version, so the
  // optimistic staleness guard cannot see it, and this is the only thing
  // standing between an approver and a frozen field. Using the entries (SPL-304)
  // keeps an `/enabled`-only proposal applicable under a live Run.
  const frozen = await approvedProposalFreeze(deps, input);
  if (frozen) return frozen;

  // Write only fields the Request's own entries move. The Approval target hash
  // treats `flagConfigVersion` as the whole Flag Configuration content signal,
  // and every production writer bumps it, so a normal PATCH landing before the
  // staleness read makes the Request stale. This is defense in depth for the
  // TOCTOU window after that read but before this function's independent re-read:
  // `updateFlagConfig` CASes the version it just read, not the approved version,
  // so a concurrent PATCH still satisfies CAS and must not be overwritten from
  // the mint-time `proposed` snapshot.
  const patch = approvedConfigPatch(input);
  const rulesChanged = diffEntriesTouch(input.diffEntries, "targetingRules");
  if (!rulesChanged && !approvedPatchMovesConfig(patch)) {
    return { ok: false, reason: "APPROVAL_EMPTY_CHANGE" };
  }
  if (rulesChanged) {
    const replaced = await deps.repo.flags.replaceTargetingRules(
      scope,
      input.flagId,
      targetingRuleRows(input.proposed.targetingRules, new Date(input.approval.reviewedAt)),
      patch,
      input.approval,
    );
    if (!replaced.ok) {
      return targetingRulePersistFailure(
        replaced,
        input.proposed.targetingRules,
        "APPROVAL_NOT_APPLIED",
      );
    }
  } else if (
    !(await deps.repo.flags.updateFlagConfig(scope, input.flagId, patch, input.approval))
  ) {
    return { ok: false, reason: "APPROVAL_NOT_APPLIED" };
  }
  const committed = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!committed) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, input.flagId, committed);
}

/** Patch keys whose JSON Pointer appears in `diff.entries` (plus `updatedAt`). */
export function approvedConfigPatch(input: ApplyApprovedFlagConfigInput): {
  updatedAt: string;
  updatedBy: string;
  updatedVia: string;
  enabled?: boolean;
  availableVariantNames?: string;
  rollout?: string | null;
} {
  const patch: {
    updatedAt: string;
    updatedBy: string;
    updatedVia: string;
    enabled?: boolean;
    availableVariantNames?: string;
    rollout?: string | null;
  } = {
    updatedAt: input.approval.reviewedAt,
    updatedBy: input.actor.ref,
    updatedVia: input.actor.via,
  };
  if (diffEntriesTouch(input.diffEntries, "enabled")) {
    patch.enabled = input.proposed.enabled;
  }
  if (diffEntriesTouch(input.diffEntries, "availableVariantNames")) {
    patch.availableVariantNames = json(input.proposed.availableVariantNames);
  }
  if (diffEntriesTouch(input.diffEntries, "rollout")) {
    patch.rollout = input.proposed.rollout ? json(input.proposed.rollout) : null;
  }
  return patch;
}

/** True when the patch would move a Flag Configuration column (not only `updatedAt`). */
export function approvedPatchMovesConfig(patch: ReturnType<typeof approvedConfigPatch>): boolean {
  return (
    patch.enabled !== undefined ||
    patch.availableVariantNames !== undefined ||
    patch.rollout !== undefined
  );
}

async function validateProposal(
  deps: ConfigStoreRuntimeDeps,
  current: Snapshot,
  input: ApplyApprovedFlagConfigInput,
): Promise<Extract<FlagConfigWriteResult, { ok: false }> | null> {
  const missingVariants = missingAvailableVariants(
    input.proposed.availableVariantNames,
    current.flag.variants,
  );
  const missingRuleVariants = missingRuleVariantNames(
    input.proposed.targetingRules,
    current.flag.variants,
    input.proposed.availableVariantNames,
  );
  if (missingVariants.length + missingRuleVariants.length > 0) {
    return {
      ok: false,
      reason: "VARIANT_NOT_AVAILABLE",
      missingVariants: [...new Set([...missingVariants, ...missingRuleVariants])],
    };
  }
  const resolved = await resolveTargetingRules(
    deps.repo,
    input.appId,
    input.proposed.targetingRules,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      reason: "SEGMENT_NOT_FOUND",
      missingSegmentIds: resolved.missingSegmentIds,
    };
  }
  const defaultVariant = current.flag.variants.find(
    (variant) => variant.id === current.flag.defaultVariantId,
  );
  return baselineIsUnresolvable(
    input.proposed.rollout,
    input.proposed.availableVariantNames,
    defaultVariant?.name,
    current.flag.variants.map((variant) => variant.name),
  )
    ? {
        ok: false,
        reason: "ROLLOUT_AMBIGUOUS",
        availableVariantNames: input.proposed.availableVariantNames,
      }
    : null;
}
