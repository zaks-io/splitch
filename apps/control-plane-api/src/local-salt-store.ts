import type { KeyVersion, SaltStore } from "@splitch/privacy";

const LOCAL_VERSION = "local-v1";

/** Same App Entity salt source Evaluation / Event Ingest use for Targeting Key HMAC. */
export function makeEnvSaltStore(env: {
  EVALUATION_PRIVACY_SALT?: string;
  SPLITCH_PLATFORM_TARGET?: string;
}): SaltStore {
  return {
    async currentKeyVersion() {
      return LOCAL_VERSION;
    },
    async saltFor(_appId: string, keyVersion: KeyVersion) {
      if (keyVersion !== LOCAL_VERSION) {
        throw new Error(`control-plane-api: unknown salt version ${keyVersion}`);
      }
      const salt = env.EVALUATION_PRIVACY_SALT ?? localOnlySalt(env.SPLITCH_PLATFORM_TARGET);
      return new TextEncoder().encode(salt) as Uint8Array<ArrayBuffer>;
    },
  };
}

function localOnlySalt(target: string | undefined): string {
  if (target === undefined || target === "local" || target === "pr-ci") {
    return "splitch-local-evaluation-salt";
  }
  throw new Error("control-plane-api: EVALUATION_PRIVACY_SALT is required outside local targets");
}
