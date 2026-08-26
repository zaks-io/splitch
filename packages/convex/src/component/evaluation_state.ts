import type {
  EvaluateResult,
  EvaluationContext,
  VariantValue,
} from "@splitch/sdk/local-evaluation";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { hmacHex, stableUuid } from "./crypto";
import { DELIVERY_LEASE_MS, scheduleDeliveryWatch } from "./exposure_delivery";
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
  for (const row of outbox) await ctx.db.delete(row._id);
  for (const row of assignments) await ctx.db.delete(row._id);
  if (assignments.length === 100 || outbox.length === 100) {
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

export async function runtimeState(ctx: QueryCtx | MutationCtx, context: EvaluationContext) {
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
  const rows = await ctx.db
    .query("assignments")
    .withIndex("by_entity_experiment", (q) =>
      q.eq("idType", context.idType).eq("targetingKeyHash", targetingKeyHash),
    )
    .take(1_001);
  if (rows.length > 1_000)
    throw new Error("ASSIGNMENT_LIMIT_EXCEEDED: Entity has more than 1000 local Assignments");
  const assignments = new Map<string, { runId: string; variant: string }>(
    rows.map((row) => [row.experimentId, { runId: row.runId, variant: row.variant }]),
  );
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
  await ctx.scheduler.runAfter(0, internal.evaluation.deliver, { exposureId });
  await scheduleDeliveryWatch(ctx, exposureId, DELIVERY_LEASE_MS);
}

export async function localTargetingKeyHash(
  key: string,
  context: EvaluationContext,
): Promise<string> {
  return hmacHex(key, `${context.idType}:${context.targetingKey}`);
}
