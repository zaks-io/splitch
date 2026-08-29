import { isLocalPlatformTarget, requirePlatformTarget } from "@splitch/contracts";
import {
  type AppIdentityKv,
  type AppIdentityCoordinatorNamespace,
  type AppIdentityStore,
  makeDurableAppIdentityStore,
  makeIdentitySaltStore,
  makeKvAppIdentityStore,
  makeMemoryAppIdentityStore,
  resolvePrivacyRootSecret,
  type SaltStore,
} from "@splitch/privacy";

export function makeEnvSaltStore(env: {
  EVALUATION_PRIVACY_SALT?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  CONFIG_STORE?: AppIdentityKv;
  CONFIG_STORE_WRITER?: AppIdentityCoordinatorNamespace;
  identityStore?: AppIdentityStore;
}): SaltStore {
  const target = requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  const rootSecret = resolvePrivacyRootSecret({
    configuredSalt: env.EVALUATION_PRIVACY_SALT,
    localFixtureAllowed: isLocalPlatformTarget(target),
  });
  return makeIdentitySaltStore({
    rootSecret,
    identityStore: resolveIdentityStore(env, target, rootSecret),
  });
}

function resolveIdentityStore(
  env: {
    CONFIG_STORE?: AppIdentityKv;
    CONFIG_STORE_WRITER?: AppIdentityCoordinatorNamespace;
    identityStore?: AppIdentityStore;
  },
  target: ReturnType<typeof requirePlatformTarget>,
  rootSecret: string,
): AppIdentityStore {
  if (env.identityStore) return env.identityStore;
  if (env.CONFIG_STORE && isLocalPlatformTarget(target)) {
    return makeKvAppIdentityStore({
      kv: asAppIdentityKv(env.CONFIG_STORE),
      rootSecret,
    });
  }
  if (isLocalPlatformTarget(target)) {
    return makeMemoryAppIdentityStore();
  }
  if (!env.CONFIG_STORE) {
    throw new Error("CONFIG_STORE is required outside local targets");
  }
  if (!env.CONFIG_STORE_WRITER) {
    throw new Error("CONFIG_STORE_WRITER is required outside local targets");
  }
  return makeDurableAppIdentityStore({
    namespace: env.CONFIG_STORE_WRITER,
    rootSecret,
  });
}

function asAppIdentityKv(kv: AppIdentityKv): AppIdentityKv {
  return {
    get: (key) => kv.get(key),
    put: (key, value) => kv.put(key, value),
  };
}
