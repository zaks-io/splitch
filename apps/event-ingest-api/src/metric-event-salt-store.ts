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
        putIfAbsent: metricEventAppIdentityPutIfAbsent(kv, target, env.CONFIG_STORE_WRITER),
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
  target: ReturnType<typeof requirePlatformTarget>,
  writer: Env["CONFIG_STORE_WRITER"],
): (recordKey: string, value: string) => Promise<string> {
  if (writer === undefined) {
    if (!isLocalPlatformTarget(target)) {
      throw new Error("CONFIG_STORE_WRITER is required outside local targets");
    }
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
  return durable;
}
