import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requiredIntegration } from "./integration_state";

const CURRENT_KEY = "current" as const;
export const SYNC_RECOVERY_DELAY_MS = 60_000;

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
