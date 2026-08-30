import { v } from "convex/values";

export const variantValueValidator = v.union(
  v.boolean(),
  v.string(),
  v.number(),
  v.record(v.string(), v.any()),
);

export const evaluationContextValidator = v.object({
  targetingKey: v.string(),
  idType: v.string(),
  attributes: v.record(v.string(), v.any()),
});

export const metricEventArgsValidator = {
  eventName: v.string(),
  targetingKey: v.string(),
  idType: v.string(),
  eventId: v.string(),
  fields: v.record(v.string(), v.any()),
  dimensions: v.record(v.string(), v.union(v.boolean(), v.string(), v.number())),
};

export const metricEventTrackReceiptValidator = v.object({
  eventId: v.string(),
  queued: v.literal(true),
});

export const metricEventDeliveryStatusValidator = v.object({
  eventId: v.string(),
  state: v.union(
    v.literal("missing"),
    v.literal("queued"),
    v.literal("accepted"),
    v.literal("terminal"),
    v.literal("suppressed"),
  ),
  error: v.optional(v.string()),
});

export const metricEventDeliveryClaimValidator = v.union(
  v.null(),
  v.object({
    endpoint: v.string(),
    request: v.object(metricEventArgsValidator),
    leaseExpiresAt: v.number(),
  }),
);

export const resolutionDetailsValidator = v.object({
  value: variantValueValidator,
  variantName: v.union(v.string(), v.null()),
  reason: v.union(
    v.literal("SPLIT"),
    v.literal("TARGETING_MATCH"),
    v.literal("DEFAULT"),
    v.literal("DISABLED"),
    v.literal("CACHED"),
    v.literal("STALE"),
    v.literal("ERROR"),
  ),
  ruleId: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
});

export const installationResultValidator = v.object({
  installationId: v.string(),
  appId: v.string(),
  environmentId: v.string(),
  environmentVersion: v.number(),
  status: v.union(v.literal("active"), v.literal("revoked")),
});

export const deliveryClaimValidator = v.union(
  v.null(),
  v.object({
    endpoint: v.string(),
    row: v.object({
      exposureId: v.string(),
      installationId: v.string(),
      flagKey: v.string(),
      experimentId: v.string(),
      runId: v.string(),
      runConfigHash: v.string(),
      evaluationContext: evaluationContextValidator,
      variantName: v.string(),
      exposureAt: v.string(),
    }),
    attemptCount: v.number(),
    leaseExpiresAt: v.number(),
  }),
);

const exposureDeliveryItemValidator = v.object({
  exposureId: v.string(),
  installationId: v.string(),
  flagKey: v.string(),
  experimentId: v.string(),
  runId: v.string(),
  runConfigHash: v.string(),
  evaluationContext: evaluationContextValidator,
  variantName: v.string(),
  exposureAt: v.string(),
});

export const deliveryBatchClaimValidator = v.union(
  v.null(),
  v.object({
    endpoint: v.string(),
    rows: v.array(exposureDeliveryItemValidator),
    leaseExpiresAt: v.number(),
  }),
);
