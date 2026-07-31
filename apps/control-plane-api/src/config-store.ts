import { DeltaNudgeSchema } from "@splitch/contracts";
import { appScope, type EnvScope, envScope } from "@splitch/db";
import { applyApprovedFlagConfig } from "./config-store-approved-write";
import { configPatchFreeze, targetingFreeze } from "./config-store-freeze";
import { deleteFlagConfigSnapshot } from "./config-store-kv";
import { promoteFlagConfig, replaceTargetingRules } from "./config-store-mutations";
import {
  type ApplyApprovedFlagConfigInput,
  buildExperimentSnapshotFromD1,
  buildSnapshotFromD1,
  type ConfigStoreDeps,
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
import { baselineIsUnresolvable, nextBaselineRollout } from "./flag-config-rollout";

export type { ConfigStoreDeps } from "./config-store-shared";

export interface ConfigStoreWriter {
  readFlagConfig(
    input: Omit<PatchFlagConfigInput, "enabled" | "availableVariantNames">,
  ): Promise<{ ok: true; config: FlagConfigResult } | { ok: false; reason: "FLAG_NOT_FOUND" }>;
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

interface FlagConfigDeleteInput {
  appId: string;
  environmentId: string;
  flagId: string;
  flagKey?: string;
}

type FlagConfigDeleteResult =
  | { ok: true; nudge: import("@splitch/contracts").DeltaNudge }
  | { ok: false; reason: "FLAG_NOT_FOUND" };

interface ExperimentConfigSyncInput {
  appId: string;
  environmentId: string;
  experimentId: string;
}

interface FlagConfigResyncInput {
  appId: string;
  environmentId: string;
  flagId: string;
}

export function makeConfigStore(deps: ConfigStoreDeps): ConfigStoreWriter {
  return {
    async readFlagConfig(input) {
      const scope = envScope(input.appId, input.environmentId);
      const snapshot = await readFlagSnapshot(deps, scope, input.flagId);
      if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
      return { ok: true, config: responseFromSnapshot(snapshot) };
    },

    async writeFlagConfig(input) {
      return writeFlagConfig(deps, input);
    },

    async replaceTargetingRules(input) {
      return replaceTargetingRules(deps, input);
    },

    async promoteFlagConfig(input) {
      return promoteFlagConfig(deps, input);
    },

    async previewFlagConfig(input) {
      return previewFlagConfig(deps, input);
    },

    async previewTargetingRules(input) {
      const frozen = await targetingFreeze(deps, input);
      if (frozen) return frozen;

      const scope = envScope(input.appId, input.environmentId);
      const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
      if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
      const missingVariants = missingRuleVariantNames(
        input.targetingRules,
        snapshot.flag.variants,
        snapshot.flag.availableVariantNames,
      );
      if (missingVariants.length > 0) {
        return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants };
      }
      return previewSnapshotResult(snapshot, {
        targetingRules: input.targetingRules,
      });
    },

    async previewPromotion(input) {
      return promoteFlagConfig(deps, { ...input, preview: true });
    },

    async applyApprovedFlagConfig(input) {
      return applyApprovedFlagConfig(deps, input);
    },

    async syncExperimentConfig(input) {
      return syncExperimentConfig(deps, input);
    },

    async resyncFlagConfig(input) {
      const scope = envScope(input.appId, input.environmentId);
      const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
      if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
      return writeSnapshotAndBroadcast(deps, scope, snapshot.flag.id, snapshot);
    },

    async deleteFlagConfig(input) {
      return deleteFlagConfigFromStore(deps, input);
    },
  };
}

async function deleteFlagConfigFromStore(
  deps: ConfigStoreDeps,
  input: FlagConfigDeleteInput,
): Promise<FlagConfigDeleteResult> {
  const scope = envScope(input.appId, input.environmentId);
  const flag =
    (input.flagKey
      ? { key: input.flagKey }
      : await deps.repo.flags.getFlag(appScope(input.appId), input.flagId)) ?? null;
  if (!flag) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const existing = await readFlagSnapshot(deps, scope, input.flagId);
  const experimentId = existing?.flag.experimentId ?? null;
  await deleteFlagConfigSnapshot(deps.kv, scope, flag.key, experimentId);

  const nudge = DeltaNudgeSchema.parse({
    type: "config.changed",
    entity: "flag",
    id: input.flagId,
    version: 0,
  });
  await deps.broadcaster.broadcast(nudge);
  return { ok: true, nudge };
}

async function syncExperimentConfig(
  deps: ConfigStoreDeps,
  input: ExperimentConfigSyncInput,
): Promise<FlagConfigWriteResult> {
  const scope = envScope(input.appId, input.environmentId);
  const snapshot = await buildExperimentSnapshotFromD1(deps.repo, scope, input.experimentId);
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, snapshot.flag.id, snapshot);
}

async function writeFlagConfig(
  deps: ConfigStoreDeps,
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
  deps: ConfigStoreDeps,
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

function previewSnapshotResult(
  current: Snapshot,
  patch: Partial<
    Pick<Snapshot["flag"], "enabled" | "availableVariantNames" | "targetingRules" | "rollout">
  >,
): FlagConfigWriteResult {
  const proposed: Snapshot = {
    ...current,
    version: current.version + 1,
    flag: {
      ...current.flag,
      ...patch,
    },
  };
  return {
    ok: true,
    config: responseFromSnapshot(proposed),
    nudge: DeltaNudgeSchema.parse({
      type: "config.changed",
      entity: "flag",
      id: current.flag.id,
      version: proposed.version,
    }),
  };
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
  deps: ConfigStoreDeps,
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
    },
    input.approval,
  );
  return updated ? buildSnapshotFromD1(deps.repo, scope, input.flagId) : null;
}
