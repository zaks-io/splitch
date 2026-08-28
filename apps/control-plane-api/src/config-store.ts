import { type EnvScope, envScope } from "@splitch/db";
import { applyApprovedFlagConfig } from "./config-store-approved-write";
import { configPatchFreeze, targetingFreeze } from "./config-store-freeze";
import { makeConfigStoreMutationQueue } from "./config-store-mutation-queue";
import { promoteFlagConfig } from "./config-store-mutations";
import { previewSnapshotResult, previewTargetingRules } from "./config-store-preview";
import {
  type ApplyApprovedFlagConfigInput,
  buildExperimentSnapshotFromD1,
  buildSnapshotFromD1,
  type ConfigStoreDeps,
  type ConfigStoreRuntimeDeps,
  type FlagConfigResult,
  type FlagConfigWriteResult,
  json,
  missingAvailableVariants,
  missingRuleVariantNames,
  type PatchFlagConfigInput,
  type PromoteFlagConfigInput,
  type PromoteFlagConfigResult,
  type ReplaceTargetingRulesInput,
  readFlagSnapshot,
  responseFromSnapshot,
  type Snapshot,
  writeSnapshotAndBroadcast,
} from "./config-store-shared";
import {
  deleteFlagConfigFromStore,
  type FlagConfigDeleteInput,
  type FlagConfigDeleteResult,
  type FlagConfigResyncInput,
  repairFlagConfigSnapshot,
} from "./config-store-snapshot-maintenance";
import { DeletedFlagConfigSnapshotError } from "./config-store-snapshot-revision";
import { replaceTargetingRules } from "./config-store-targeting-rules";
import { baselineIsUnresolvable, nextBaselineRollout } from "./flag-config-rollout";
import { SegmentNotFoundError } from "./targeting-rule-resolution";

export type { ConfigStoreDeps } from "./config-store-shared";

export interface ConfigStoreWriter {
  readFlagConfig(
    input: Omit<PatchFlagConfigInput, "actor" | "enabled" | "availableVariantNames">,
  ): Promise<
    | { ok: true; config: FlagConfigResult }
    | { ok: false; reason: "FLAG_NOT_FOUND" }
    | { ok: false; reason: "SEGMENT_NOT_FOUND"; missingSegmentIds: string[] }
  >;
  repairFlagConfigSnapshot(
    input: Omit<PatchFlagConfigInput, "actor" | "enabled" | "availableVariantNames">,
  ): Promise<
    | { ok: true; config: FlagConfigResult; snapshotRevision: number }
    | { ok: false; reason: "FLAG_NOT_FOUND" }
    | { ok: false; reason: "SEGMENT_NOT_FOUND"; missingSegmentIds: string[] }
  >;
  writeFlagConfig(input: PatchFlagConfigInput): Promise<FlagConfigWriteResult>;
  replaceTargetingRules(input: ReplaceTargetingRulesInput): Promise<FlagConfigWriteResult>;
  promoteFlagConfig(input: PromoteFlagConfigInput): Promise<PromoteFlagConfigResult>;
  previewFlagConfig(input: PatchFlagConfigInput): Promise<FlagConfigWriteResult>;
  previewTargetingRules(input: ReplaceTargetingRulesInput): Promise<FlagConfigWriteResult>;
  previewPromotion(input: PromoteFlagConfigInput): Promise<PromoteFlagConfigResult>;
  applyApprovedFlagConfig(input: ApplyApprovedFlagConfigInput): Promise<FlagConfigWriteResult>;
  syncExperimentConfig(input: ExperimentConfigSyncInput): Promise<FlagConfigWriteResult>;
  /**
   * Rebuild one Environment's KV Flag snapshot from D1 without mutating D1.
   * Used after an app-scoped Variant catalog change (create/update/delete),
   * whose new values/names must reach the data plane's KV blob — the blob embeds
   * the full Variant catalog and is otherwise only rewritten on config writes.
   * `FLAG_NOT_FOUND` here means the Environment simply has no config for the Flag
   * (nothing to resync), not an error.
   */
  resyncFlagConfig(input: FlagConfigResyncInput): Promise<FlagConfigWriteResult>;
  /**
   * Idempotently remove one Environment's KV Flag snapshot and broadcast cache
   * invalidation. Safe to retry after D1 rows are already gone.
   */
  deleteFlagConfig(input: FlagConfigDeleteInput): Promise<FlagConfigDeleteResult>;
}

interface ExperimentConfigSyncInput {
  appId: string;
  environmentId: string;
  experimentId: string;
}

export function makeConfigStore(deps: ConfigStoreDeps): ConfigStoreWriter {
  const runtimeDeps: ConfigStoreRuntimeDeps = {
    ...deps,
    snapshotMutations: makeConfigStoreMutationQueue(),
  };
  return {
    async readFlagConfig(input) {
      return catchSegmentNotFound(async () => {
        const scope = envScope(input.appId, input.environmentId);
        const snapshot = await readFlagSnapshot(runtimeDeps, scope, input.flagId);
        if (!snapshot) return { ok: false as const, reason: "FLAG_NOT_FOUND" as const };
        return { ok: true as const, config: responseFromSnapshot(snapshot) };
      });
    },

    async repairFlagConfigSnapshot(input) {
      try {
        return await catchSegmentNotFound(() => repairFlagConfigSnapshot(runtimeDeps, input));
      } catch (cause) {
        if (cause instanceof DeletedFlagConfigSnapshotError) {
          return { ok: false, reason: "FLAG_NOT_FOUND" };
        }
        throw cause;
      }
    },

    async writeFlagConfig(input) {
      return catchSegmentNotFound(() => writeFlagConfig(runtimeDeps, input));
    },

    async replaceTargetingRules(input) {
      return catchSegmentNotFound(() => replaceTargetingRules(runtimeDeps, input));
    },

    async promoteFlagConfig(input) {
      return promoteFlagConfig(runtimeDeps, input);
    },

    async previewFlagConfig(input) {
      return catchSegmentNotFound(() => previewFlagConfig(runtimeDeps, input));
    },

    async previewTargetingRules(input) {
      return catchSegmentNotFound(() => previewTargetingRules(runtimeDeps, input));
    },

    async previewPromotion(input) {
      return promoteFlagConfig(runtimeDeps, { ...input, preview: true });
    },

    async applyApprovedFlagConfig(input) {
      return catchSegmentNotFound(() => applyApprovedFlagConfig(runtimeDeps, input));
    },

    async syncExperimentConfig(input) {
      return catchSegmentNotFound(() => syncExperimentConfig(runtimeDeps, input));
    },

    async resyncFlagConfig(input) {
      const frozen = await targetingFreeze(runtimeDeps, input);
      if (frozen) return frozen;
      return resyncFromD1(runtimeDeps, input);
    },

    async deleteFlagConfig(input) {
      return deleteFlagConfigFromStore(runtimeDeps, input);
    },
  };
}

async function resyncFromD1(deps: ConfigStoreRuntimeDeps, input: FlagConfigResyncInput) {
  return catchSegmentNotFound(async () => {
    const scope = envScope(input.appId, input.environmentId);
    const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
    if (!snapshot) return { ok: false as const, reason: "FLAG_NOT_FOUND" as const };
    return writeSnapshotAndBroadcast(deps, scope, snapshot.flag.id, snapshot);
  });
}

async function catchSegmentNotFound<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof SegmentNotFoundError) {
      return {
        ok: false as const,
        reason: "SEGMENT_NOT_FOUND" as const,
        missingSegmentIds: cause.missingSegmentIds,
      };
    }
    throw cause;
  }
}

async function syncExperimentConfig(
  deps: ConfigStoreRuntimeDeps,
  input: ExperimentConfigSyncInput,
): Promise<FlagConfigWriteResult> {
  const scope = envScope(input.appId, input.environmentId);
  const snapshot = await buildExperimentSnapshotFromD1(deps.repo, scope, input.experimentId);
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, snapshot.flag.id, snapshot);
}

async function writeFlagConfig(
  deps: ConfigStoreRuntimeDeps,
  input: PatchFlagConfigInput,
): Promise<FlagConfigWriteResult> {
  const frozen = await configPatchFreeze(deps, input);
  if (frozen) return frozen;

  const scope = envScope(input.appId, input.environmentId);
  const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const missingVariants = missingAvailableVariants(
    input.availableVariantNames,
    snapshot.flag.variants,
  );
  if (missingVariants.length > 0) {
    return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants };
  }

  const missingRuleVariants = missingRuleVariantNames(
    snapshot.flag.targetingRules,
    snapshot.flag.variants,
    input.availableVariantNames ?? snapshot.flag.availableVariantNames,
  );
  if (missingRuleVariants.length > 0) {
    return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants: missingRuleVariants };
  }

  // Both fields are checked against the state this write LANDS, not against the
  // patch: widening availability strands an existing baseline just as surely as
  // setting a baseline under an already-wide available set.
  const available = input.availableVariantNames ?? snapshot.flag.availableVariantNames;
  const rollout = input.rollout === undefined ? snapshot.flag.rollout : input.rollout;
  const defaultVariant = snapshot.flag.variants.find(
    (variant) => variant.id === snapshot.flag.defaultVariantId,
  );
  if (
    baselineIsUnresolvable(
      rollout,
      available,
      defaultVariant?.name,
      snapshot.flag.variants.map((variant) => variant.name),
    )
  ) {
    return { ok: false, reason: "ROLLOUT_AMBIGUOUS", availableVariantNames: available };
  }

  const commit = await commitFlagConfigPatch(deps, scope, input, snapshot);
  if (!commit) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, input.flagId, commit);
}

async function previewFlagConfig(
  deps: ConfigStoreRuntimeDeps,
  input: PatchFlagConfigInput,
): Promise<FlagConfigWriteResult> {
  // The preview is what the Policy gate turns into an Approval Request, so it is
  // refused for the same reason the commit is: a proposal a live Run can never
  // let land must not exist for a reviewer to approve.
  const frozen = await configPatchFreeze(deps, input);
  if (frozen) return frozen;

  const scope = envScope(input.appId, input.environmentId);
  const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
  const validation = validateFlagConfigPatch(snapshot, input);
  if (validation) return validation;
  const rollout = nextBaselineRollout(
    snapshot.flag.rollout,
    input.rollout,
    input.approvalRolloutSalt ? () => input.approvalRolloutSalt as string : undefined,
  );
  return previewSnapshotResult(snapshot, {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.availableVariantNames !== undefined
      ? { availableVariantNames: input.availableVariantNames }
      : {}),
    ...(rollout !== undefined ? { rollout } : {}),
  });
}

function validateFlagConfigPatch(
  snapshot: Snapshot,
  input: PatchFlagConfigInput,
): Extract<FlagConfigWriteResult, { ok: false }> | null {
  const missingVariants = missingAvailableVariants(
    input.availableVariantNames,
    snapshot.flag.variants,
  );
  if (missingVariants.length > 0) {
    return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants };
  }
  const available = input.availableVariantNames ?? snapshot.flag.availableVariantNames;
  const missingRuleVariants = missingRuleVariantNames(
    snapshot.flag.targetingRules,
    snapshot.flag.variants,
    available,
  );
  if (missingRuleVariants.length > 0) {
    return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants: missingRuleVariants };
  }
  const rollout = input.rollout === undefined ? snapshot.flag.rollout : input.rollout;
  const defaultVariant = snapshot.flag.variants.find(
    (variant) => variant.id === snapshot.flag.defaultVariantId,
  );
  return baselineIsUnresolvable(
    rollout,
    available,
    defaultVariant?.name,
    snapshot.flag.variants.map((variant) => variant.name),
  )
    ? { ok: false, reason: "ROLLOUT_AMBIGUOUS", availableVariantNames: available }
    : null;
}

async function commitFlagConfigPatch(
  deps: ConfigStoreRuntimeDeps,
  scope: EnvScope,
  input: PatchFlagConfigInput,
  current: Snapshot,
): Promise<Snapshot | null> {
  // Resolved against the CURRENT stored rollout so an existing salt survives a
  // percentage change (see flag-config-rollout.ts); `undefined` leaves it alone.
  const rollout = nextBaselineRollout(current.flag.rollout, input.rollout);
  const updated = await deps.repo.flags.updateFlagConfig(
    scope,
    input.flagId,
    {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.availableVariantNames !== undefined
        ? { availableVariantNames: json(input.availableVariantNames) }
        : {}),
      ...(rollout !== undefined ? { rollout: rollout === null ? null : json(rollout) } : {}),
      updatedAt: input.approval?.reviewedAt ?? (deps.now?.() ?? new Date()).toISOString(),
      updatedBy: input.actor.ref,
      updatedVia: input.actor.via,
    },
    input.approval,
  );
  return updated ? buildSnapshotFromD1(deps.repo, scope, input.flagId) : null;
}
