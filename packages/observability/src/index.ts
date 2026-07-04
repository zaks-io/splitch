// biome-ignore lint/performance/noBarrelFile: package public-API entry aggregates observability surfaces
export {
  createScrubbedEmitter,
  createSentryBeforeSend,
  secretsFromEnv,
  type LogLevel,
  type ObservabilitySecrets,
  type ScrubbedEmitter,
  type ScrubbedEmitterConfig,
} from "./emitter.js";
export { initCliObservability, cliEmitter } from "./cli.js";
export { initSdkHarnessObservability, sdkHarnessEmitter } from "./sdk-harness.js";
export {
  OBSERVABILITY_SURFACE_KINDS,
  OBSERVABILITY_SURFACES,
  isObservabilitySurfaceId,
  observabilitySurfaceIds,
  type ObservabilitySurfaceId,
  type ObservabilitySurfaceKind,
} from "./surfaces.js";
