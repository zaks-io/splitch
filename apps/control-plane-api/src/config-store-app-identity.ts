import {
  assertAppIdentityTrafficAllowed,
  defaultAppEntityIdentityRecordKey,
  makeKvAppIdentityStore,
  parseWrappedAppIdentityRecord,
  requireAppIdentityRecord,
  resetCompromisedAppIdentity,
  resolvePrivacyRootSecret,
  unwrapAppIdentityRecord,
} from "@splitch/privacy";
import {
  completeProductionAppIdentityReset,
  productionAppIdentityResetPurgers,
} from "./app-identity-reset-runtime";
import type { ControlPlaneApiEnv } from "./env";

export function putConfigStoreAppIdentityIfAbsent(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
  value: string,
): Promise<string> {
  assertAppIdentityScope(ctx, appId);
  return ctx.blockConcurrencyWhile(async () => {
    await unwrapAppIdentityRecord(
      parseWrappedAppIdentityRecord(value),
      privacyRootSecret(env),
      appId,
    );
    const key = defaultAppEntityIdentityRecordKey(appId);
    const existing = await ctx.storage.get<string>(key);
    if (existing !== undefined) return existing;
    await ctx.storage.put(key, value);
    return value;
  });
}

export function readConfigStoreAppIdentity(
  ctx: DurableObjectState,
  appId: string,
): Promise<string | null> {
  assertAppIdentityScope(ctx, appId);
  return ctx.storage
    .get<string>(defaultAppEntityIdentityRecordKey(appId))
    .then((value) => value ?? null);
}

export function resetConfigStoreAppIdentity(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
  resetId: string,
): Promise<string> {
  assertAppIdentityScope(ctx, appId);
  return ctx.blockConcurrencyWhile(async () => {
    const record = await resetCompromisedAppIdentity(
      configStoreAppIdentityStore(ctx, env),
      appId,
      resetId,
      productionAppIdentityResetPurgers(env, resetId),
      () => completeProductionAppIdentityReset(env, appId, resetId),
    );
    return record.currentVersion;
  });
}

export async function assertConfigStoreAppIdentityTrafficAllowed(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
): Promise<void> {
  assertAppIdentityScope(ctx, appId);
  const record = await requireAppIdentityRecord(configStoreAppIdentityStore(ctx, env), appId);
  assertAppIdentityTrafficAllowed(record.lifecycle);
}

export function configStoreAppIdentityStore(ctx: DurableObjectState, env: ControlPlaneApiEnv) {
  return makeKvAppIdentityStore({
    kv: {
      get: async (key) => (await ctx.storage.get<string>(key)) ?? null,
      put: (key, value) => ctx.storage.put(key, value),
    },
    rootSecret: privacyRootSecret(env),
    durablySerializedReset: true,
    exclusive: { runExclusive: (_appId, run) => run() },
  });
}

function privacyRootSecret(env: ControlPlaneApiEnv): string {
  return resolvePrivacyRootSecret({
    configuredSalt: env.EVALUATION_PRIVACY_SALT,
    localFixtureAllowed: env.SPLITCH_PLATFORM_TARGET === "local",
  });
}

function assertAppIdentityScope(ctx: DurableObjectState, appId: string): void {
  if (ctx.id.name !== `app-identity:${appId}`) {
    throw new Error("config-store: App identity coordinator scope mismatch");
  }
}
