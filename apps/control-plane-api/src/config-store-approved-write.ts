import { envScope } from "@splitch/db";
import { approvedProposalFreeze } from "./config-store-freeze";
import {
  type ApplyApprovedFlagConfigInput,
  buildSnapshotFromD1,
  type ConfigStoreDeps,
  type FlagConfigWriteResult,
  json,
  missingAvailableVariants,
  missingRuleVariantNames,
  type Snapshot,
  targetingRuleRows,
  writeSnapshotAndBroadcast,
} from "./config-store-shared";
import { baselineIsUnresolvable } from "./flag-config-rollout";
import { diffEntriesTouch } from "./flag-config-run-freeze-proposal";

/**
 * The write an approved Approval Request performs. It is separate from the
 * direct patch path because the proposal is COMPLETE state, not a partial patch:
 * every field is validated against what the write lands, and the D1 mutation
 * carries the Review commit so a lost guard leaves the edge untouched.
 */
export async function applyApprovedFlagConfig(
  deps: ConfigStoreDeps,
  input: ApplyApprovedFlagConfigInput,
): Promise<FlagConfigWriteResult> {
  const scope = envScope(input.appId, input.environmentId);
  const current = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!current) return { ok: false, reason: "FLAG_NOT_FOUND" };
  const invalid = validateProposal(current, input);
  if (invalid) return invalid;
  // Judged against the request's own changed-field set (`diff.entries`), not
  // against a re-diff of the complete proposed snapshot: a Run started after
  // the proposal was minted bumps no Flag Configuration version, so the
  // optimistic staleness guard cannot see it, and this is the only thing
  // standing between an approver and a frozen field. Using the entries (SPL-304)
  // keeps an `/enabled`-only proposal applicable under a live Run.
  const frozen = await approvedProposalFreeze(deps, input);
  if (frozen) return frozen;

  // Write only fields the request's own entries move. An enabled-only proposal
  // carries mint-time `availableVariantNames` / `rollout` in `proposed`; writing
  // them unconditionally would revert live state a Run now owns after the
  // entries-based freeze correctly let the kill-switch through (SPL-304).
  const patch = approvedConfigPatch(input);
  const rulesChanged = diffEntriesTouch(input.diffEntries, "targetingRules");
  const updated = rulesChanged
    ? await deps.repo.flags.replaceTargetingRules(
        scope,
        input.flagId,
        targetingRuleRows(input.proposed.targetingRules, new Date(input.approval.reviewedAt)),
        patch,
        input.approval,
      )
    : await deps.repo.flags.updateFlagConfig(scope, input.flagId, patch, input.approval);
  // The Configuration was read above, so null here is the guarded write saying
  // it landed nothing, not a missing Flag. Returning before the KV write keeps
  // the edge from publishing a snapshot for a change that never applied.
  if (!updated) return { ok: false, reason: "APPROVAL_NOT_APPLIED" };
  const committed = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!committed) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, input.flagId, committed);
}

/** Patch keys whose JSON Pointer appears in `diff.entries` (plus `updatedAt`). */
export function approvedConfigPatch(input: ApplyApprovedFlagConfigInput): {
  updatedAt: string;
  enabled?: boolean;
  availableVariantNames?: string;
  rollout?: string | null;
} {
  const patch: {
    updatedAt: string;
    enabled?: boolean;
    availableVariantNames?: string;
    rollout?: string | null;
  } = { updatedAt: input.approval.reviewedAt };
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

function validateProposal(
  current: Snapshot,
  input: ApplyApprovedFlagConfigInput,
): Extract<FlagConfigWriteResult, { ok: false }> | null {
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
