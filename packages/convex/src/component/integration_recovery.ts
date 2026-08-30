import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { ensureExposureDrainScheduled } from "./exposure_batch";
import { requiredIntegration } from "./integration_state";
import { scheduleMetricEventDeliveryWatch } from "./metric_event_delivery";
import { ensureRetentionScheduled } from "./retention";

const CURRENT_KEY = "current" as const;
const ADOPTION_BATCH_SIZE = 25;
export const RECOVERY_GENERATION = 2;
export const SYNC_RECOVERY_DELAY_MS = 60_000;

export const adoptExistingWork = internalMutation({
  args: { generation: v.number() },
  returns: v.null(),
  handler: adoptExistingWorkHandler,
});

export async function activateHandler(
  ctx: MutationCtx,
  args: { appId: string; environmentId: string; environmentVersion: number },
): Promise<void> {
  const integration = await requiredIntegration(ctx);
  const announcedVersion = Math.max(integration.announcedVersion, args.environmentVersion);
  await ctx.db.patch(integration._id, {
    appId: args.appId,
    environmentId: args.environmentId,
    announcedVersion,
    state: "active",
  });
  await scheduleSyncRecovery(
    ctx,
    { ...integration, announcedVersion, state: "active" },
    SYNC_RECOVERY_DELAY_MS,
  );
  await ensureRetentionScheduled(ctx);
  await scheduleRecoveryAdoption(ctx, { ...integration, state: "active" });
}

export async function adoptExistingWorkHandler(
  ctx: MutationCtx,
  args: { generation: number },
): Promise<void> {
  const integration = await currentIntegration(ctx);
  if (!integration || (integration.recoveryGeneration ?? 0) >= args.generation) return;

  const [pending, delivering, pendingMetricEvents, deliveringMetricEvents] = await Promise.all([
    legacyExposureDeliveries(ctx, "pending"),
    legacyExposureDeliveries(ctx, "delivering"),
    legacyMetricEventDeliveries(ctx, "pending"),
    legacyMetricEventDeliveries(ctx, "delivering"),
  ]);
  for (const row of [...pending, ...delivering]) {
    await ctx.db.patch(row._id, { recoveryWatchGeneration: args.generation });
  }
  if (pending.length > 0 || delivering.length > 0)
    await ensureExposureDrainScheduled(ctx, Date.now());
  for (const row of [...pendingMetricEvents, ...deliveringMetricEvents]) {
    await scheduleMetricEventDeliveryWatch(ctx, row.eventId, 0);
    await ctx.db.patch(row._id, { recoveryWatchGeneration: args.generation });
  }

  if (
    pending.length === ADOPTION_BATCH_SIZE ||
    delivering.length === ADOPTION_BATCH_SIZE ||
    pendingMetricEvents.length === ADOPTION_BATCH_SIZE ||
    deliveringMetricEvents.length === ADOPTION_BATCH_SIZE
  ) {
    const jobId = await ctx.scheduler.runAfter(
      0,
      internal.integration_recovery.adoptExistingWork,
      args,
    );
    await ctx.db.patch(integration._id, { recoveryAdoptionJobId: jobId });
    return;
  }

  await ctx.db.patch(integration._id, {
    recoveryAdoptionJobId: undefined,
    recoveryGeneration: args.generation,
  });
  await ensureRetentionScheduled(ctx);
}

function legacyExposureDeliveries(ctx: MutationCtx, state: "pending" | "delivering") {
  return legacyDeliveries(ctx, "exposureOutbox", state) as Promise<Doc<"exposureOutbox">[]>;
}

function legacyMetricEventDeliveries(ctx: MutationCtx, state: "pending" | "delivering") {
  return legacyDeliveries(ctx, "metricEventOutbox", state) as Promise<Doc<"metricEventOutbox">[]>;
}

async function legacyDeliveries(
  ctx: MutationCtx,
  table: "exposureOutbox" | "metricEventOutbox",
  state: "pending" | "delivering",
) {
  const read = (generation: number | undefined) =>
    ctx.db
      .query(table)
      .withIndex("by_recovery_watch_state", (q) =>
        q.eq("recoveryWatchGeneration", generation).eq("state", state),
      )
      .take(ADOPTION_BATCH_SIZE);
  const withoutGeneration = await read(undefined);
  if (withoutGeneration.length === ADOPTION_BATCH_SIZE) return withoutGeneration;
  const firstGeneration = await read(1);
  return [...withoutGeneration, ...firstGeneration].slice(0, ADOPTION_BATCH_SIZE);
}

export async function recoverSyncHandler(
  ctx: MutationCtx,
  args: { environmentVersion: number },
): Promise<void> {
  const integration = await currentIntegration(ctx);
  if (
    integration?.state !== "active" ||
    integration.syncRecoveryVersion !== args.environmentVersion
  )
    return;
  if ((integration.snapshotVersion ?? -1) >= args.environmentVersion) {
    await ctx.db.patch(integration._id, {
      syncRecoveryJobId: undefined,
      syncRecoveryVersion: undefined,
    });
    return;
  }
  await ctx.scheduler.runAfter(0, internal.integration.sync, {});
  const jobId = await ctx.scheduler.runAfter(
    SYNC_RECOVERY_DELAY_MS,
    internal.integration.recoverSync,
    args,
  );
  await ctx.db.patch(integration._id, {
    syncRecoveryJobId: jobId,
    syncRecoveryVersion: args.environmentVersion,
  });
}

export async function scheduleSyncRecovery(
  ctx: MutationCtx,
  integration: Doc<"integrations">,
  delayMs: number,
): Promise<void> {
  const existingJob = integration.syncRecoveryJobId
    ? await ctx.db.system.get("_scheduled_functions", integration.syncRecoveryJobId)
    : null;
  const existingJobIsActive =
    existingJob?.state.kind === "pending" || existingJob?.state.kind === "inProgress";
  if (existingJobIsActive && integration.syncRecoveryVersion === integration.announcedVersion)
    return;
  const existingJobId = integration.syncRecoveryJobId;
  if (existingJobId && existingJob?.state.kind === "pending")
    await ctx.scheduler.cancel(existingJobId);
  const jobId = await ctx.scheduler.runAfter(delayMs, internal.integration.recoverSync, {
    environmentVersion: integration.announcedVersion,
  });
  await ctx.db.patch(integration._id, {
    syncRecoveryJobId: jobId,
    syncRecoveryVersion: integration.announcedVersion,
  });
}

export async function scheduleRecoveryAdoption(
  ctx: MutationCtx,
  integration: Doc<"integrations">,
): Promise<void> {
  if ((integration.recoveryGeneration ?? 0) >= RECOVERY_GENERATION) return;
  const existingJob = integration.recoveryAdoptionJobId
    ? await ctx.db.system.get("_scheduled_functions", integration.recoveryAdoptionJobId)
    : null;
  if (existingJob?.state.kind === "pending" || existingJob?.state.kind === "inProgress") return;
  const jobId = await ctx.scheduler.runAfter(0, internal.integration_recovery.adoptExistingWork, {
    generation: RECOVERY_GENERATION,
  });
  await ctx.db.patch(integration._id, { recoveryAdoptionJobId: jobId });
}

export async function cancelPendingSyncRecovery(
  ctx: MutationCtx,
  integration: Doc<"integrations">,
): Promise<void> {
  if (!integration.syncRecoveryJobId) return;
  const job = await ctx.db.system.get("_scheduled_functions", integration.syncRecoveryJobId);
  if (job?.state.kind === "pending") await ctx.scheduler.cancel(integration.syncRecoveryJobId);
}

async function currentIntegration(ctx: MutationCtx): Promise<Doc<"integrations"> | null> {
  return ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", CURRENT_KEY))
    .unique();
}
