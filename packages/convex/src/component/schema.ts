import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const deliveryState = v.union(
  v.literal("pending"),
  v.literal("delivering"),
  v.literal("accepted"),
  v.literal("terminal"),
  v.literal("suppressed"),
);

export default defineSchema({
  integrations: defineTable({
    key: v.literal("current"),
    installationId: v.string(),
    webhookSecret: v.string(),
    previousWebhookSecret: v.optional(v.string()),
    pendingRotationId: v.optional(v.string()),
    componentIdentityKey: v.string(),
    endpoint: v.string(),
    callbackUrl: v.string(),
    appId: v.optional(v.string()),
    environmentId: v.optional(v.string()),
    announcedVersion: v.number(),
    snapshotVersion: v.optional(v.number()),
    syncRecoveryJobId: v.optional(v.id("_scheduled_functions")),
    syncRecoveryVersion: v.optional(v.number()),
    retentionJobId: v.optional(v.id("_scheduled_functions")),
    retentionDueAt: v.optional(v.number()),
    state: v.union(v.literal("pending"), v.literal("active"), v.literal("revoked")),
  }).index("by_key", ["key"]),
  snapshots: defineTable({
    key: v.literal("current"),
    environmentVersion: v.number(),
    payload: v.string(),
  }).index("by_key", ["key"]),
  assignments: defineTable({
    experimentId: v.string(),
    idType: v.string(),
    targetingKeyHash: v.optional(v.string()),
    runId: v.string(),
    variant: v.string(),
  }).index("by_entity_experiment", ["idType", "targetingKeyHash", "experimentId"]),
  evaluationClaims: defineTable({
    idempotencyKey: v.string(),
    fingerprint: v.string(),
    result: v.string(),
    createdAt: v.optional(v.number()),
  })
    .index("by_key", ["idempotencyKey"])
    .index("by_created_at", ["createdAt"]),
  entityDeletions: defineTable({
    idType: v.string(),
    targetingKeyHash: v.string(),
  }).index("by_entity", ["idType", "targetingKeyHash"]),
  exposureOutbox: defineTable({
    exposureId: v.string(),
    installationId: v.string(),
    evaluationFingerprint: v.string(),
    flagKey: v.string(),
    experimentId: v.string(),
    runId: v.string(),
    runConfigHash: v.string(),
    idType: v.string(),
    targetingKeyHash: v.optional(v.string()),
    targetingKey: v.optional(v.string()),
    attributesJson: v.optional(v.string()),
    variantName: v.string(),
    exposedAtCommitTs: v.commitTs(),
    createdAt: v.number(),
    state: deliveryState,
    attemptCount: v.number(),
    nextAttemptAt: v.number(),
    terminalAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_exposure", ["exposureId"])
    .index("by_state_next_attempt", ["state", "nextAttemptAt"])
    .index("by_state_terminal_at", ["state", "terminalAt"])
    .index("by_entity_state", ["idType", "targetingKeyHash", "state"]),
  webhookClaims: defineTable({
    deliveryId: v.string(),
    claimedAt: v.number(),
  })
    .index("by_delivery", ["deliveryId"])
    .index("by_claimed_at", ["claimedAt"]),
});
