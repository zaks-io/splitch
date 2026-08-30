import type {
  EvaluateResult,
  EvaluationContext,
  VariantValue,
} from "@splitch/sdk/local-evaluation";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { hmacHex, stableUuid } from "./crypto";
import { ensureExposureDrainScheduled } from "./exposure_batch";
import { ensureRetentionScheduled } from "./retention";
import { parseSnapshot } from "./snapshot";

export async function purgeEntityBatch(
  ctx: MutationCtx,
  idType: string,
  targetingKeyHash: string,
): Promise<void> {
  const inFlight = await ctx.db
    .query("exposureOutbox")
    .withIndex("by_entity_state", (q) =>
      q.eq("idType", idType).eq("targetingKeyHash", targetingKeyHash).eq("state", "delivering"),
    )
    .first();
  if (inFlight)
    throw new Error(
      "ENTITY_DELIVERY_IN_PROGRESS: Retry deletion after the active delivery finishes",
    );
  const metricEventInFlight = await ctx.db
    .query("metricEventOutbox")
    .withIndex("by_entity_state", (q) =>
      q.eq("idType", idType).eq("targetingKeyHash", targetingKeyHash).eq("state", "delivering"),
    )
    .first();
  if (metricEventInFlight)
    throw new Error(
      "ENTITY_DELIVERY_IN_PROGRESS: Retry deletion after the active delivery finishes",
    );

  const existingDeletion = await ctx.db
    .query("entityDeletions")
    .withIndex("by_entity", (q) => q.eq("idType", idType).eq("targetingKeyHash", targetingKeyHash))
    .unique();
  if (!existingDeletion) await ctx.db.insert("entityDeletions", { idType, targetingKeyHash });

  const assignments = await ctx.db
    .query("assignments")
    .withIndex("by_entity_experiment", (q) =>
      q.eq("idType", idType).eq("targetingKeyHash", targetingKeyHash),
    )
    .take(100);
  const outbox = await ctx.db
    .query("exposureOutbox")
    .withIndex("by_entity_state", (q) =>
      q.eq("idType", idType).eq("targetingKeyHash", targetingKeyHash),
    )
    .take(100);
  const metricEventCount = await suppressMetricEvents(ctx, idType, targetingKeyHash);
  for (const row of outbox) await ctx.db.delete(row._id);
  for (const row of assignments) await ctx.db.delete(row._id);
  if (assignments.length === 100 || outbox.length === 100 || metricEventCount === 100) {
    await ctx.scheduler.runAfter(0, internal.evaluation.continueDeleteEntity, {
      idType,
      targetingKeyHash,
    });
    return;
  }
  const deletion = await ctx.db
    .query("entityDeletions")
    .withIndex("by_entity", (q) => q.eq("idType", idType).eq("targetingKeyHash", targetingKeyHash))
    .unique();
  if (deletion) await ctx.db.delete(deletion._id);
}

async function suppressMetricEvents(
  ctx: MutationCtx,
  idType: string,
  targetingKeyHash: string,
): Promise<number> {
  const rows = await ctx.db
    .query("metricEventOutbox")
    .withIndex("by_entity_state", (q) =>
      q.eq("idType", idType).eq("targetingKeyHash", targetingKeyHash),
    )
    .take(100);
  for (const row of rows) {
    const claim = await ctx.db
      .query("metricEventClaims")
      .withIndex("by_event", (q) => q.eq("eventId", row.eventId))
      .unique();
    if (!claim) throw new Error(`Metric Event "${row.eventId}" is missing its idempotency claim`);
    await ctx.db.patch(claim._id, {
      state: "suppressed",
      completedAt: Date.now(),
      lastError: "Entity deletion suppressed delivery",
    });
    await ctx.db.delete(row._id);
  }
  if (rows.length > 0) await ensureRetentionScheduled(ctx);
  return rows.length;
}

export async function runtimeState(
  ctx: QueryCtx | MutationCtx,
  flagKey: string,
  context: EvaluationContext,
) {
  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
  if (integration?.state !== "active" || !integration.appId || !integration.environmentId)
    throw new Error("@splitch/convex is not installed");
  const stored = await ctx.db
    .query("snapshots")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
  if (!stored) throw new Error("PROVIDER_NOT_READY: @splitch/convex has no configuration snapshot");
  if (stored.environmentVersion < integration.announcedVersion)
    throw new Error(
      `STALE: snapshot ${stored.environmentVersion} is behind announced version ${integration.announcedVersion}`,
    );
  const snapshot = parseSnapshot(stored.payload);
  const targetingKeyHash = await localTargetingKeyHash(integration.componentIdentityKey, context);
  const experimentId = snapshot.flags.find((flag) => flag.key === flagKey)?.experimentId;
  const assignment = experimentId
    ? await ctx.db
        .query("assignments")
        .withIndex("by_entity_experiment", (q) =>
          q
            .eq("idType", context.idType)
            .eq("targetingKeyHash", targetingKeyHash)
            .eq("experimentId", experimentId),
        )
        .unique()
    : null;
  const assignments = new Map<string, { runId: string; variant: string }>();
  if (assignment)
    assignments.set(assignment.experimentId, {
      runId: assignment.runId,
      variant: assignment.variant,
    });
  return { integration, snapshot, assignments };
}

export async function persistExposure(
  ctx: MutationCtx,
  args: {
    flagKey: string;
    context: EvaluationContext;
    defaultValue: VariantValue;
    idempotencyKey: string;
  },
  runtime: Awaited<ReturnType<typeof runtimeState>>,
  exposure: NonNullable<EvaluateResult["exposure"]>,
  fingerprint: string,
): Promise<void> {
  const integration = runtime.integration;
  const run = runtime.snapshot.runs.find((candidate) => candidate.id === exposure.liveRunId);
  if (!run) throw new Error(`Live Run "${exposure.liveRunId}" is absent from the Convex snapshot`);
  const targetingKeyHash = await localTargetingKeyHash(
    integration.componentIdentityKey,
    args.context,
  );
  const deletion = await ctx.db
    .query("entityDeletions")
    .withIndex("by_entity", (q) =>
      q.eq("idType", args.context.idType).eq("targetingKeyHash", targetingKeyHash),
    )
    .unique();
  if (deletion) throw new Error("ENTITY_DELETION_IN_PROGRESS");
  const existing = await ctx.db
    .query("assignments")
    .withIndex("by_entity_experiment", (q) =>
      q
        .eq("idType", args.context.idType)
        .eq("targetingKeyHash", targetingKeyHash)
        .eq("experimentId", exposure.experimentId),
    )
    .unique();
  if (!existing) {
    await ctx.db.insert("assignments", {
      experimentId: exposure.experimentId,
      idType: args.context.idType,
      targetingKeyHash,
      runId: exposure.liveRunId,
      variant: exposure.variant,
    });
  }
  const exposureId = await stableUuid(`${integration.installationId}:${args.idempotencyKey}`);
  await ctx.db.insert("exposureOutbox", {
    exposureId,
    installationId: integration.installationId,
    evaluationFingerprint: fingerprint,
    flagKey: args.flagKey,
    experimentId: exposure.experimentId,
    runId: exposure.liveRunId,
    runConfigHash: run.configHash,
    idType: args.context.idType,
    targetingKeyHash,
    targetingKey: args.context.targetingKey,
    attributesJson: JSON.stringify(args.context.attributes),
    variantName: exposure.variant,
    exposedAtCommitTs: ctx.db.vars.commitTs,
    createdAt: Date.now(),
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: Date.now(),
  });
  await ensureExposureDrainScheduled(ctx, Date.now());
}

export async function localTargetingKeyHash(
  key: string,
  context: EvaluationContext,
): Promise<string> {
  return hmacHex(key, `${context.idType}:${context.targetingKey}`);
}
