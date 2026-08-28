import { isLocalPlatformTarget, requirePlatformTarget } from "@splitch/contracts";
import {
  makeDurableAppIdentityPutIfAbsent,
  makeIdentitySaltStore,
  makeKvAppIdentityStore,
  makeMemoryAppIdentityStore,
  putWrappedAppIdentityIfAbsent,
  resolvePrivacyRootSecret,
} from "@splitch/privacy";
import type { Env } from "./types";

export function makeMetricEventSaltStore(env: Env) {
  const target = requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  const rootSecret = resolvePrivacyRootSecret({
    configuredSalt: env.EVALUATION_PRIVACY_SALT,
    localFixtureAllowed: isLocalPlatformTarget(target),
  });
  const configStore = env.CONFIG_STORE;
  if (configStore) {
    const kv = {
      get: async (key: string) => (await configStore.get(key, "text")) ?? null,
      put: (key: string, value: string) => configStore.put(key, value),
    };
    return makeIdentitySaltStore({
      rootSecret,
      identityStore: makeKvAppIdentityStore({
        kv,
        rootSecret,
        putIfAbsent: metricEventAppIdentityPutIfAbsent(kv, env.CONFIG_STORE_WRITER),
      }),
    });
  }
  if (isLocalPlatformTarget(target)) {
    return makeIdentitySaltStore({
      rootSecret,
      identityStore: makeMemoryAppIdentityStore(),
    });
  }
  throw new Error("CONFIG_STORE is required outside local targets");
}

function metricEventAppIdentityPutIfAbsent(
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> },
  writer: Env["CONFIG_STORE_WRITER"],
): (recordKey: string, value: string) => Promise<string> {
  if (writer === undefined) {
    return (recordKey, value) => putWrappedAppIdentityIfAbsent(kv, recordKey, value);
  }
  const durable = makeDurableAppIdentityPutIfAbsent({
    getByName(name) {
      const stub = writer.getByName(name);
      if (typeof stub.putAppIdentityIfAbsent !== "function") {
        throw new Error("event-ingest-api: App identity coordinator is unavailable");
      }
      return { putAppIdentityIfAbsent: stub.putAppIdentityIfAbsent.bind(stub) };
    },
  });
  return async (recordKey, value) => {
    try {
      return await durable(recordKey, value);
    } catch (cause) {
      if (cause instanceof Error && /coordinator is unavailable/u.test(cause.message)) {
        return putWrappedAppIdentityIfAbsent(kv, recordKey, value);
      }
      throw cause;
    }
  };
}
