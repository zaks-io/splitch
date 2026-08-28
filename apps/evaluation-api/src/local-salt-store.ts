import { isLocalPlatformTarget, requirePlatformTarget } from "@splitch/contracts";
import {
  type AppIdentityKv,
  type AppIdentityStore,
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
  identityStore?: AppIdentityStore;
}): SaltStore {
  const target = requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  const rootSecret = resolvePrivacyRootSecret({
    configuredSalt: env.EVALUATION_PRIVACY_SALT,
    localFixtureAllowed: isLocalPlatformTarget(target),
  });
  const identityStore = resolveIdentityStore(env, target, rootSecret);
  return makeIdentitySaltStore({
    rootSecret,
    identityStore,
  });
}

function resolveIdentityStore(
  env: {
    CONFIG_STORE?: AppIdentityKv;
    identityStore?: AppIdentityStore;
  },
  target: ReturnType<typeof requirePlatformTarget>,
  rootSecret: string,
): AppIdentityStore {
  if (env.identityStore) return env.identityStore;
  if (env.CONFIG_STORE) {
    return makeKvAppIdentityStore({ kv: asAppIdentityKv(env.CONFIG_STORE), rootSecret });
  }
  if (isLocalPlatformTarget(target)) {
    return makeMemoryAppIdentityStore();
  }
  throw new Error("CONFIG_STORE is required outside local targets");
}

function asAppIdentityKv(kv: AppIdentityKv): AppIdentityKv {
  return {
    get: (key) => kv.get(key),
    put: (key, value) => kv.put(key, value),
  };
}
