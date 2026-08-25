import type {
  ConvexExposureVerificationConfig,
  ConvexServerExposureItem,
  ExposureEvent,
} from "@splitch/contracts";
import type { ExperimentConfig, FlagConfig, Provider } from "@splitch/evaluation-core";
import { computeTargetingKeyHash, type SaltStore } from "@splitch/privacy";

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_EXPOSURE_AGE_MS = 24 * 60 * 60 * 1_000;

export function matchesConvexExposure(
  item: ConvexServerExposureItem,
  exposure: { experimentId: string; liveRunId: string; variant: string } | null,
  config: ConvexExposureVerificationConfig,
): boolean {
  return (
    exposure !== null &&
    exposure.experimentId === item.experimentId &&
    exposure.liveRunId === item.runId &&
    exposure.variant === item.variantName &&
    config.runId === item.runId &&
    config.runConfigHash === item.runConfigHash
  );
}

export function isConvexExposureTimeAccepted(
  exposureAt: string,
  config: Pick<ConvexExposureVerificationConfig, "startedAt" | "endedAt">,
  now: Date,
): boolean {
  const timestamp = new Date(exposureAt).getTime();
  const startedAt = new Date(config.startedAt).getTime();
  const endedAt = config.endedAt === null ? null : new Date(config.endedAt).getTime();
  return (
    timestamp >= startedAt &&
    (endedAt === null || timestamp <= endedAt) &&
    timestamp <= now.getTime() + MAX_FUTURE_SKEW_MS &&
    now.getTime() - timestamp <= MAX_EXPOSURE_AGE_MS
  );
}

export function frozenConvexRunProvider(config: ConvexExposureVerificationConfig): Provider {
  const controlVariant = config.variantSet.find(
    (variant) => variant.id === config.controlVariantId,
  );
  if (!controlVariant) {
    throw new Error("Convex Exposure verification Run has no frozen Control Variant");
  }
  const flag: FlagConfig = {
    flagKey: config.flagKey,
    appId: config.appId,
    environmentId: config.environmentId,
    experimentId: config.experimentId,
    enabled: true,
    defaultVariant: controlVariant.name,
    variants: config.variantSet,
    availableVariantNames: config.variantSet.map((variant) => variant.name),
    targetingRules: [],
    rollout: null,
  };
  const experiment: ExperimentConfig = {
    experimentId: config.experimentId,
    appId: config.appId,
    environmentId: config.environmentId,
    targetingKeyType: config.targetingKeyType,
    status: "running",
    liveRunId: config.runId,
    liveRun: {
      runId: config.runId,
      salt: config.salt,
      allocation: config.allocation,
      variantSet: config.variantSet,
      targetingRules: config.targetingRules,
      targetingKey: config.targetingKey,
      configHash: config.runConfigHash,
    },
  };
  return {
    async getExperiment() {
      return experiment;
    },
    async getFlag() {
      return flag;
    },
    async getFlags() {
      return [flag];
    },
  };
}

export async function makeConvexExposureEvent(
  item: ConvexServerExposureItem,
  appId: string,
  environmentId: string,
  deps: { saltStore: SaltStore; now?: () => Date },
): Promise<ExposureEvent & { isHoldover: false }> {
  const targetingKeyHash = await computeTargetingKeyHash(deps.saltStore, {
    appId,
    idType: item.evaluationContext.idType,
    targetingKey: item.evaluationContext.targetingKey,
  });
  const sourceId = `convex:${item.installationId}`;
  const dedupKey = `sha256:${await sha256Hex(
    [
      "exposure",
      appId,
      item.experimentId,
      item.runId,
      item.evaluationContext.idType,
      targetingKeyHash,
      sourceId,
      item.exposureId,
    ].join(":"),
  )}`;
  return {
    appId,
    environmentId,
    experimentId: item.experimentId,
    runId: item.runId,
    idType: item.evaluationContext.idType,
    targetingKeyHash,
    variantName: item.variantName,
    type: "exposure",
    eventId: item.exposureId,
    dedupKey,
    sourceId,
    counterfactual: false,
    isHoldover: false,
    clientTimestamp: item.exposureAt,
    exposureAt: item.exposureAt,
    serverReceivedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}

export const EMPTY_CONVEX_ASSIGNMENTS = {
  async getAll() {
    return new Map();
  },
  async put() {
    throw new Error("Convex Exposure verification is read-only");
  },
  async putHashed() {
    throw new Error("Convex Exposure verification is read-only");
  },
};

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
