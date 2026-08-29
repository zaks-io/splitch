import { isLocalPlatformTarget, requirePlatformTarget } from "@splitch/contracts";
import {
  makeDurableAppIdentityStore,
  makeIdentitySaltStore,
  makeKvAppIdentityStore,
  makeMemoryAppIdentityStore,
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
  if (configStore && isLocalPlatformTarget(target)) {
    const kv = {
      get: async (key: string) => (await configStore.get(key, "text")) ?? null,
      put: (key: string, value: string) => configStore.put(key, value),
    };
    return makeIdentitySaltStore({
      rootSecret,
      identityStore: makeKvAppIdentityStore({ kv, rootSecret }),
    });
  }
  if (isLocalPlatformTarget(target)) {
    return makeIdentitySaltStore({
      rootSecret,
      identityStore: makeMemoryAppIdentityStore(),
    });
  }
  if (!configStore) {
    throw new Error("CONFIG_STORE is required outside local targets");
  }
  if (!env.CONFIG_STORE_WRITER) {
    throw new Error("CONFIG_STORE_WRITER is required outside local targets");
  }
  return makeIdentitySaltStore({
    rootSecret,
    identityStore: makeDurableAppIdentityStore({
      namespace: env.CONFIG_STORE_WRITER,
      rootSecret,
    }),
  });
}
