import {
  assertAppIdentityTrafficAllowed,
  defaultAppEntityIdentityRecordKey,
  makeKvAppIdentityStore,
  parseWrappedAppIdentityRecord,
  provisionAppIdentity,
  resetCompromisedAppIdentity,
  resolvePrivacyRootSecret,
  unwrapAppIdentityRecord,
} from "@splitch/privacy";
import {
  productionAppIdentityResetPurgers,
  productionAppIdentityResetReleasers,
} from "./app-identity-reset-runtime";
import type { ControlPlaneApiEnv } from "./env";

const APP_IDENTITY_TRAFFIC_LEASE_MS = 10_000;
const APP_IDENTITY_TRAFFIC_LEASE_KEY = "app-identity-traffic-lease-expires-at";

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

export async function leaseConfigStoreAppIdentity(
  ctx: DurableObjectState,
  appId: string,
): Promise<{ readonly value: string | null; readonly expiresAt: number }> {
  assertAppIdentityScope(ctx, appId);
  const expiresAt = Date.now() + APP_IDENTITY_TRAFFIC_LEASE_MS;
  const value = await ctx.storage.transaction(async (txn) => {
    const currentExpiry = (await txn.get<number>(APP_IDENTITY_TRAFFIC_LEASE_KEY)) ?? 0;
    await txn.put(APP_IDENTITY_TRAFFIC_LEASE_KEY, Math.max(currentExpiry, expiresAt));
    return (await txn.get<string>(defaultAppEntityIdentityRecordKey(appId))) ?? null;
  });
  return { value, expiresAt };
}

export function resetConfigStoreAppIdentity(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
  resetId: string,
): Promise<string> {
  assertAppIdentityScope(ctx, appId);
  return ctx.blockConcurrencyWhile(async () => {
    await waitForAppIdentityTrafficLeases(ctx);
    const record = await resetCompromisedAppIdentity(
      configStoreAppIdentityStore(ctx, env, appId),
      appId,
      resetId,
      productionAppIdentityResetPurgers(env, resetId),
      productionAppIdentityResetReleasers(env, appId, resetId),
    );
    return record.currentVersion;
  });
}

export async function waitForAppIdentityTrafficLeases(ctx: DurableObjectState): Promise<void> {
  const expiresAt = (await ctx.storage.get<number>(APP_IDENTITY_TRAFFIC_LEASE_KEY)) ?? 0;
  const remainingMs = expiresAt - Date.now();
  if (remainingMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
  }
  await ctx.storage.delete(APP_IDENTITY_TRAFFIC_LEASE_KEY);
}

export async function assertConfigStoreAppIdentityTrafficAllowed(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
): Promise<void> {
  assertAppIdentityScope(ctx, appId);
  const rootSecret = privacyRootSecret(env);
  // Apps created before per-App epochs have no record until their first
  // Evaluation, ingest, or retained-data read. All three paths must elect the
  // same durable first writer so a dormant App never needs an operator backfill.
  const record = await provisionAppIdentity(
    configStoreAppIdentityStore(ctx, env, appId),
    appId,
    rootSecret,
  );
  assertAppIdentityTrafficAllowed(record.lifecycle);
}

export function configStoreAppIdentityStore(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
) {
  return makeKvAppIdentityStore({
    kv: {
      get: async (key) => (await ctx.storage.get<string>(key)) ?? null,
      put: (key, value) => ctx.storage.put(key, value),
    },
    rootSecret: privacyRootSecret(env),
    putIfAbsent: (_key, value) => putConfigStoreAppIdentityIfAbsent(ctx, env, appId, value),
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
