import { appScope, envScope, type Repository } from "@splitch/db";
import { deleteEnvironmentCredentials } from "./app-environment-credentials";
import type { AppEnvironmentDeps } from "./app-environment-model";
import type { ConfigStoreAccess } from "./config-store-do";
import { randomHex } from "./credential-cache";

export interface FlagConfigLifecycleDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  credentialStore?: KVNamespace;
  credentialCacheWriter?: AppEnvironmentDeps["credentialCacheWriter"];
  nowIso?: () => string;
}

interface InitialFlagConfigInput {
  appId: string;
  flagId: string;
  defaultVariantId: string;
}

export async function initializeFlagConfigsForFlag(
  deps: FlagConfigLifecycleDeps,
  input: InitialFlagConfigInput,
): Promise<void> {
  const environments = await deps.repo.identity.listEnvironments(appScope(input.appId));
  for (const environment of environments) {
    await ensureInitialFlagConfig(deps, {
      appId: input.appId,
      environmentId: environment.id,
      flagId: input.flagId,
      defaultVariantId: input.defaultVariantId,
    });
  }
}

export async function initializeFlagConfigsForEnvironment(
  deps: FlagConfigLifecycleDeps,
  appId: string,
  environmentId: string,
): Promise<void> {
  const flags = await deps.repo.flags.flags.findMany(appScope(appId));
  for (const flag of flags) {
    if (!flag.defaultVariantId) {
      throw new Error(
        `initializeFlagConfigsForEnvironment: flag ${flag.id} has no defaultVariantId`,
      );
    }
    await ensureInitialFlagConfig(deps, {
      appId,
      environmentId,
      flagId: flag.id,
      defaultVariantId: flag.defaultVariantId,
    });
  }
}

export async function purgeFlagConfigsKvForFlag(
  deps: FlagConfigLifecycleDeps,
  appId: string,
  flagId: string,
): Promise<void> {
  const flag = await deps.repo.flags.getFlag(appScope(appId), flagId);
  if (!flag) return;
  await purgeFlagConfigsKvForKey(deps, appId, flagId, flag.key);
}

/**
 * The same purge with the Flag key supplied by the caller, for the path that
 * deletes the D1 rows first (an approved delete) and so cannot look the key up
 * afterwards.
 */
export async function purgeFlagConfigsKvForKey(
  deps: FlagConfigLifecycleDeps,
  appId: string,
  flagId: string,
  flagKey: string,
): Promise<void> {
  const environments = await deps.repo.identity.listEnvironments(appScope(appId));
  for (const environment of environments) {
    await purgeFlagConfigKv(deps, appId, environment.id, flagId, flagKey);
  }
}

export async function deleteFlagD1Cascade(
  deps: FlagConfigLifecycleDeps,
  appId: string,
  flagId: string,
): Promise<void> {
  const scope = appScope(appId);
  const environments = await deps.repo.identity.listEnvironments(scope);
  // Archived Experiment + Run purge lives inside deleteFlagCascade (same batch /
  // Approval guard) so a declined Review cannot destroy retained rows.
  await deps.repo.flags.deleteFlagCascade(
    scope,
    flagId,
    environments.map((environment) => environment.id),
  );
}

async function removeFlagConfigsForEnvironment(
  deps: FlagConfigLifecycleDeps,
  appId: string,
  environmentId: string,
): Promise<void> {
  const scope = envScope(appId, environmentId);
  const configs = await deps.repo.flags.flagConfigs.findMany(scope);
  for (const config of configs) {
    const flag = await deps.repo.flags.getFlag(appScope(appId), config.flagId);
    if (!flag) continue;
    await removeFlagConfigAt(deps, appId, environmentId, config.flagId, flag.key);
  }
}

export async function rollbackCreatedEnvironment(
  deps: FlagConfigLifecycleDeps,
  appId: string,
  environmentId: string,
): Promise<void> {
  await removeFlagConfigsForEnvironment(deps, appId, environmentId);
  await deleteEnvironmentCredentials(deps, appId, environmentId);
  await deps.repo.identity.deleteEnvironment(appScope(appId), environmentId);
}

async function removeFlagConfigAt(
  deps: FlagConfigLifecycleDeps,
  appId: string,
  environmentId: string,
  flagId: string,
  flagKey: string,
): Promise<void> {
  await purgeFlagConfigKv(deps, appId, environmentId, flagId, flagKey);
  const scope = envScope(appId, environmentId);
  await deps.repo.flags.removeTargetingRules(scope, flagId);
  await deps.repo.flags.removeFlagConfig(scope, flagId);
}

async function ensureInitialFlagConfig(
  deps: FlagConfigLifecycleDeps,
  input: {
    appId: string;
    environmentId: string;
    flagId: string;
    defaultVariantId: string;
  },
): Promise<void> {
  const scope = envScope(input.appId, input.environmentId);
  const now = deps.nowIso?.() ?? new Date().toISOString();
  await deps.repo.flags.ensureInitialFlagConfig(scope, {
    id: `flag_config_${randomHex(12)}`,
    flagId: input.flagId,
    enabled: false,
    availableVariantNames: JSON.stringify([]),
    defaultVariantId: input.defaultVariantId,
    createdAt: now,
    updatedAt: now,
  });
  await syncFlagConfigToKv(deps, input.appId, input.environmentId, input.flagId);
}

async function syncFlagConfigToKv(
  deps: FlagConfigLifecycleDeps,
  appId: string,
  environmentId: string,
  flagId: string,
): Promise<void> {
  if (!deps.configStore) return;
  const result = await deps.configStore.writerFor(appId, environmentId).resyncFlagConfig({
    appId,
    environmentId,
    flagId,
  });
  if (!result.ok) {
    throw new Error(
      `flag-config lifecycle: KV resync failed for flag ${flagId} in ${environmentId}`,
    );
  }
}

async function purgeFlagConfigKv(
  deps: FlagConfigLifecycleDeps,
  appId: string,
  environmentId: string,
  flagId: string,
  flagKey: string,
): Promise<void> {
  if (!deps.configStore) return;
  const result = await deps.configStore.writerFor(appId, environmentId).deleteFlagConfig({
    appId,
    environmentId,
    flagId,
    flagKey,
  });
  if (!result.ok) {
    throw new Error(
      `flag-config lifecycle: KV purge failed for flag ${flagId} in ${environmentId}`,
    );
  }
}
