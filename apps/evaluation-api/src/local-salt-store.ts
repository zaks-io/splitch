import { isLocalPlatformTarget, requirePlatformTarget } from "@splitch/contracts";
import {
  DEFAULT_PRIVACY_KEY_VERSION,
  makeDerivedSaltStore,
  resolvePrivacyRootSecret,
  type SaltStore,
} from "@splitch/privacy";

export function makeEnvSaltStore(env: {
  EVALUATION_PRIVACY_SALT?: string;
  SPLITCH_PLATFORM_TARGET?: string;
}): SaltStore {
  const target = requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  const rootSecret = resolvePrivacyRootSecret({
    configuredSalt: env.EVALUATION_PRIVACY_SALT,
    localFixtureAllowed: isLocalPlatformTarget(target),
  });
  return makeDerivedSaltStore({
    rootSecret,
    currentKeyVersion: DEFAULT_PRIVACY_KEY_VERSION,
  });
}
