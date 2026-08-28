import {
  assertAppIdentityTrafficAllowed,
  makeKvAppIdentityStore,
  putWrappedAppIdentityIfAbsent,
  requireAppIdentityRecord,
  resetCompromisedAppIdentity,
  resolvePrivacyRootSecret,
} from "@splitch/privacy";
import {
  completeProductionAppIdentityReset,
  productionAppIdentityResetPurgers,
} from "./app-identity-reset-runtime";
import type { ControlPlaneApiEnv } from "./env";

export function putConfigStoreAppIdentityIfAbsent(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  recordKey: string,
  value: string,
): Promise<string> {
  return ctx.blockConcurrencyWhile(() =>
    putWrappedAppIdentityIfAbsent(
      {
        get: async (key) => (await env.CONFIG_STORE.get(key)) ?? null,
        put: (key, wrapped) => env.CONFIG_STORE.put(key, wrapped),
      },
      recordKey,
      value,
    ),
  );
}

export function resetConfigStoreAppIdentity(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
  resetId: string,
): Promise<string> {
  return ctx.blockConcurrencyWhile(async () => {
    const record = await resetCompromisedAppIdentity(
      configStoreAppIdentityStore(env),
      appId,
      resetId,
      productionAppIdentityResetPurgers(env, resetId),
      () => completeProductionAppIdentityReset(env, appId, resetId),
    );
    return record.currentVersion;
  });
}

export async function assertConfigStoreAppIdentityTrafficAllowed(
  env: ControlPlaneApiEnv,
  appId: string,
): Promise<void> {
  const record = await requireAppIdentityRecord(configStoreAppIdentityStore(env), appId);
  assertAppIdentityTrafficAllowed(record.lifecycle);
}

function configStoreAppIdentityStore(env: ControlPlaneApiEnv) {
  const rootSecret = resolvePrivacyRootSecret({
    configuredSalt: env.EVALUATION_PRIVACY_SALT,
    localFixtureAllowed: env.SPLITCH_PLATFORM_TARGET === "local",
  });
  return makeKvAppIdentityStore({
    kv: {
      get: async (key) => (await env.CONFIG_STORE.get(key, "text")) ?? null,
      put: (key, value) => env.CONFIG_STORE.put(key, value),
    },
    rootSecret,
    durablySerializedReset: true,
    exclusive: { runExclusive: (_appId, run) => run() },
  });
}
