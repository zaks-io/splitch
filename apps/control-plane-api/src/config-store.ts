import { envScope, type EnvScope } from "@splitch/db";
import { promoteFlagConfig, replaceTargetingRules } from "./config-store-mutations.js";
import {
  buildSnapshotFromD1,
  json,
  missingAvailableVariants,
  missingRuleVariantNames,
  readFlagSnapshot,
  responseFromSnapshot,
  writeSnapshotAndBroadcast,
  type ConfigStoreDeps,
  type FlagConfigResult,
  type FlagConfigWriteResult,
  type PatchFlagConfigInput,
  type PromoteFlagConfigInput,
  type PromoteFlagConfigResult,
  type ReplaceTargetingRulesInput,
  type Snapshot,
} from "./config-store-shared.js";

export type { ConfigStoreDeps } from "./config-store-shared.js";

export interface ConfigStoreWriter {
  readFlagConfig(
    input: Omit<PatchFlagConfigInput, "enabled" | "availableVariantNames">,
  ): Promise<{ ok: true; config: FlagConfigResult } | { ok: false; reason: "FLAG_NOT_FOUND" }>;
  writeFlagConfig(input: PatchFlagConfigInput): Promise<FlagConfigWriteResult>;
  replaceTargetingRules(input: ReplaceTargetingRulesInput): Promise<FlagConfigWriteResult>;
  promoteFlagConfig(input: PromoteFlagConfigInput): Promise<PromoteFlagConfigResult>;
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
  };
}

async function writeFlagConfig(
  deps: ConfigStoreDeps,
  input: PatchFlagConfigInput,
): Promise<FlagConfigWriteResult> {
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

  const commit = await commitFlagConfigPatch(deps, scope, input);
  if (!commit) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, input.flagId, commit);
}

async function commitFlagConfigPatch(
  deps: ConfigStoreDeps,
  scope: EnvScope,
  input: PatchFlagConfigInput,
): Promise<Snapshot | null> {
  const updated = await deps.repo.flags.updateFlagConfig(scope, input.flagId, {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.availableVariantNames !== undefined
      ? { availableVariantNames: json(input.availableVariantNames) }
      : {}),
    updatedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  return updated ? buildSnapshotFromD1(deps.repo, scope, input.flagId) : null;
}
