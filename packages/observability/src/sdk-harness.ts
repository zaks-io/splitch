import { createScrubbedEmitter, secretsFromEnv } from "./emitter.js";

export interface SdkHarnessObservabilityEnv {
  SENTRY_DSN?: string;
  SPLITCH_PLATFORM_TARGET?: string;
}

/**
 * SDK integration-test harness observability. The public SDK does not emit to
 * Sentry in customer apps, but the repo's SDK test harness exercises the
 * same scrubbed emission boundary as Workers and the CLI.
 */
export function initSdkHarnessObservability(
  env: SdkHarnessObservabilityEnv = process.env as SdkHarnessObservabilityEnv,
): ReturnType<typeof createScrubbedEmitter> {
  const secrets = secretsFromEnv(env);
  return createScrubbedEmitter({ surface: "sdk-harness", ...secrets });
}

export function sdkHarnessEmitter(
  env: SdkHarnessObservabilityEnv = process.env as SdkHarnessObservabilityEnv,
  hooks: Omit<Parameters<typeof createScrubbedEmitter>[0], "surface"> = {},
): ReturnType<typeof createScrubbedEmitter> {
  const secrets = secretsFromEnv(env);
  return createScrubbedEmitter({ surface: "sdk-harness", ...secrets, ...hooks });
}
