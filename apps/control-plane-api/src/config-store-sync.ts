import { activationConfigKey } from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";
import { requireWritableEnvironment } from "./config-store-expiry-fence";
import { ensureInitialFlagConfig } from "./config-store-initial-config";
import { json, targetingRuleRows } from "./config-store-shared";
import { toTargetingRule } from "./config-store-snapshot-build";
import { writeFlagConfigSnapshot } from "./config-store-snapshot-write";
import { targetingRulePersistFailure } from "./config-store-targeting-rules";
import type {
  ConfigStoreRuntimeDeps,
  FlagConfigActor,
  FlagConfigWriteResult,
} from "./config-store-types";

export interface SyncFlagConfigInput {
  actor: FlagConfigActor;
  appId: string;
  environmentId: string;
  flagId: string;
  fromEnvironmentId: string;
  initialConfig: { defaultVariantId: string };
}

/** Copies authoring rows, so neither a live Run nor its frozen configuration can escape. */
export async function syncFlagConfig(
  deps: ConfigStoreRuntimeDeps,
  input: SyncFlagConfigInput,
): Promise<FlagConfigWriteResult> {
  const target = await deps.repo.identity.getEnvironment(
    appScope(input.appId),
    input.environmentId,
  );
  if (!target || target.expiresAt === null) {
    throw new Error("config-store: Sync requires a Temporary Environment");
  }
  const sourceScope = envScope(input.appId, input.fromEnvironmentId);
  const scope = envScope(input.appId, input.environmentId);
  const { config: source, targetingRules: rows } =
    await deps.repo.flags.getFlagConfigWithTargetingRules(sourceScope, input.flagId);
  const rules = source ? rows.map(toTargetingRule) : [];
  const now = deps.now?.() ?? new Date();
  const patch = syncConfigPatch(source, input, now);
  await ensureInitialFlagConfig(deps, input, input.initialConfig);
  await requireWritableEnvironment(deps, input);
  const replaced = await deps.repo.flags.replaceTargetingRules(
    scope,
    input.flagId,
    targetingRuleRows(rules, now),
    patch,
  );
  if (!replaced.ok) return targetingRulePersistFailure(replaced, rules, "FLAG_NOT_FOUND");
  await deps.kv.delete(activationConfigKey(input.appId, input.environmentId));
  return writeFlagConfigSnapshot(deps, scope, input.flagId);
}

function syncConfigPatch(
  source: Awaited<ReturnType<Repository["flags"]["getFlagConfigWithTargetingRules"]>>["config"],
  input: SyncFlagConfigInput,
  now: Date,
) {
  if (source && !source.defaultVariantId)
    throw new Error("config-store: source configuration has no Default Variant");
  return {
    enabled: source?.enabled ?? false,
    availableVariantNames: source?.availableVariantNames ?? json([]),
    defaultVariantId: source ? source.defaultVariantId : input.initialConfig.defaultVariantId,
    rollout: source?.rollout ?? null,
    updatedAt: now.toISOString(),
    updatedBy: input.actor.ref,
    updatedVia: input.actor.via,
  };
}
