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
  const identityStore =
    env.identityStore ??
    (env.CONFIG_STORE
      ? makeKvAppIdentityStore({ kv: asAppIdentityKv(env.CONFIG_STORE), rootSecret })
      : makeMemoryAppIdentityStore());
  return makeIdentitySaltStore({
    rootSecret,
    identityStore,
  });
}

function asAppIdentityKv(kv: AppIdentityKv): AppIdentityKv {
  return {
    get: (key) => kv.get(key),
    put: (key, value) => kv.put(key, value),
  };
}
