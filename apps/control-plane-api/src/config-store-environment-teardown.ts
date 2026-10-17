import { activationConfigKey, controlPlaneFlagConfigKey, flagConfigKey } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { EnvironmentWriteScope } from "./config-store-expiry-fence";
import type { ConfigStoreRuntimeDeps } from "./config-store-types";

export interface TemporaryEnvironmentFenceInput extends EnvironmentWriteScope {
  now: string;
}

export async function fenceTemporaryEnvironment(
  deps: ConfigStoreRuntimeDeps,
  input: TemporaryEnvironmentFenceInput,
): Promise<{ ok: true } | { ok: false; reason: "ENVIRONMENT_NOT_FOUND" }> {
  const row = await deps.repo.identity.fenceTemporaryEnvironment(
    appScope(input.appId),
    input.environmentId,
    input.now,
  );
  if (!row) return { ok: false, reason: "ENVIRONMENT_NOT_FOUND" };
  if (row.expiresAt === null) throw new Error("config-store: cannot fence a permanent Environment");
  return { ok: true };
}

/** Removes projections while D1 remains the durable manifest for every retry. */
export async function teardownTemporaryEnvironmentState(
  deps: ConfigStoreRuntimeDeps,
  input: EnvironmentWriteScope,
): Promise<void> {
  const row = await deps.repo.identity.getEnvironment(appScope(input.appId), input.environmentId);
  if (!row) return;
  const expiry = row.expiresAt === null ? Number.NaN : Date.parse(row.expiresAt);
  if (!Number.isFinite(expiry) || expiry > (deps.now?.() ?? new Date()).getTime()) {
    throw new Error("config-store: teardown requires an expired Temporary Environment");
  }
  if (!deps.clearEnvironmentState)
    throw new Error("config-store: Environment state removal is not configured");
  const scope = envScope(input.appId, input.environmentId);
  const configs = await deps.repo.flags.flagConfigs.findMany(scope);
  for (const config of configs) {
    const flag = await deps.repo.flags.getFlag(appScope(input.appId), config.flagId);
    if (!flag) throw new Error("config-store: teardown manifest references a missing Flag");
    await deps.kv.delete(controlPlaneFlagConfigKey(input.appId, input.environmentId, flag.id));
    await deps.kv.delete(flagConfigKey(input.appId, input.environmentId, flag.key));
  }
  await deps.kv.delete(activationConfigKey(input.appId, input.environmentId));
  await deps.clearEnvironmentState();
}
