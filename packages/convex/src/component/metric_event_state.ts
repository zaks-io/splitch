import type { TrackRequest } from "@splitch/sdk";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canonicalJson, sha256Hex } from "./crypto";
import { DELIVERY_LEASE_MS } from "./delivery_policy";
import { localTargetingKeyHash } from "./evaluation_state";
import { requiredIntegration } from "./integration_state";
import type { MetricEventDeliveryStatus, MetricEventTrackReceipt } from "./metric_event";
import { scheduleMetricEventDeliveryWatch } from "./metric_event_delivery";
import { ensureRetentionScheduled } from "./retention";

export async function queueMetricEventHandler(
  ctx: MutationCtx,
  args: TrackRequest,
): Promise<MetricEventTrackReceipt> {
  const integration = await requiredIntegration(ctx);
  if (integration.state !== "active") throw new Error("@splitch/convex is not installed");
  const targetingKeyHash = await localTargetingKeyHash(integration.componentIdentityKey, {
    targetingKey: args.targetingKey,
    idType: args.idType,
    attributes: {},
  });
  const fingerprint = await sha256Hex(
    canonicalJson({
      eventName: args.eventName,
      idType: args.idType,
      targetingKeyHash,
      fields: args.fields,
      dimensions: args.dimensions,
    }),
  );
  const replay = await replayMetricEventClaim(ctx, args.eventId, fingerprint);
  if (replay) return replay;

  const orphanedDelivery = await ctx.db
    .query("metricEventOutbox")
    .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
    .unique();
  if (orphanedDelivery) {
    if (orphanedDelivery.fingerprint !== fingerprint)
      throw new Error("EVENT_ID_CONFLICT: eventId was reused for different Metric Event content");
    throw new Error("METRIC_EVENT_CLAIM_MISSING: Metric Event delivery has no idempotency claim");
  }
  const deletion = await ctx.db
    .query("entityDeletions")
    .withIndex("by_entity", (q) =>
      q.eq("idType", args.idType).eq("targetingKeyHash", targetingKeyHash),
    )
    .unique();
  if (deletion) throw new Error("ENTITY_DELETION_IN_PROGRESS");

  const now = Date.now();
  await ctx.db.insert("metricEventClaims", {
    eventId: args.eventId,
    fingerprint,
    createdAt: now,
    state: "queued",
  });
  await ctx.db.insert("metricEventOutbox", {
    eventId: args.eventId,
    installationId: integration.installationId,
    fingerprint,
    eventName: args.eventName,
    idType: args.idType,
    targetingKeyHash,
    targetingKey: args.targetingKey,
    fieldsJson: JSON.stringify(args.fields),
    dimensionsJson: JSON.stringify(args.dimensions),
    createdAt: now,
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: now,
    recoveryWatchGeneration: 1,
  });
  await ctx.scheduler.runAfter(0, internal.metric_event.deliver, { eventId: args.eventId });
  await scheduleMetricEventDeliveryWatch(ctx, args.eventId, DELIVERY_LEASE_MS);
  await ensureRetentionScheduled(ctx);
  return { eventId: args.eventId, queued: true };
}

async function replayMetricEventClaim(
  ctx: MutationCtx,
  eventId: string,
  fingerprint: string,
): Promise<MetricEventTrackReceipt | null> {
  const claim = await ctx.db
    .query("metricEventClaims")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .unique();
  if (!claim) return null;
  if (claim.fingerprint !== fingerprint)
    throw new Error("EVENT_ID_CONFLICT: eventId was reused for different Metric Event content");
  if (claim.state === "terminal" || claim.state === "suppressed")
    throw new Error(
      `METRIC_EVENT_DELIVERY_${claim.state.toUpperCase()}: ${claim.lastError ?? "Metric Event delivery stopped"}`,
    );
  if (claim.state === "queued") {
    const delivery = await ctx.db
      .query("metricEventOutbox")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!delivery)
      throw new Error("METRIC_EVENT_OUTBOX_MISSING: Queued Metric Event has no delivery row");
  }
  await ensureRetentionScheduled(ctx);
  return { eventId, queued: true };
}

export async function metricEventStatusHandler(
  ctx: QueryCtx | MutationCtx,
  args: { eventId: string },
): Promise<MetricEventDeliveryStatus> {
  const claim = await ctx.db
    .query("metricEventClaims")
    .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
    .unique();
  if (!claim) return { eventId: args.eventId, state: "missing" };
  return {
    eventId: args.eventId,
    state: claim.state,
    ...(claim.lastError ? { error: claim.lastError } : {}),
  };
}
