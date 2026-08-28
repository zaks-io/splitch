import {
  appIdentityKeyRecordKey,
  isLocalPlatformTarget,
  requirePlatformTarget,
} from "@splitch/contracts";
import {
  EVALUATION_IDENTITY_EPOCH,
  makeKvIdentityKeyPersist,
  makeMemoryIdentityKeyPersist,
  makePersistedIdentitySaltStore,
  resolvePrivacyRootSecret,
  type IdentitySaltStore,
} from "@splitch/privacy";

export function makeEnvSaltStore(env: {
  EVALUATION_PRIVACY_SALT?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  CONFIG_STORE?: {
    get(key: string): Promise<string | null>;
    put?(key: string, value: string): Promise<void>;
  };
}): IdentitySaltStore {
  const target = requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  const rootSecret = resolvePrivacyRootSecret({
    configuredSalt: env.EVALUATION_PRIVACY_SALT,
    localFixtureAllowed: isLocalPlatformTarget(target),
  });
  const persist = env.CONFIG_STORE
    ? makeKvIdentityKeyPersist(env.CONFIG_STORE, appIdentityKeyRecordKey)
    : makeMemoryIdentityKeyPersist();
  return makePersistedIdentitySaltStore({
    persist,
    rootSecret,
    currentKeyVersion: EVALUATION_IDENTITY_EPOCH,
  });
}
