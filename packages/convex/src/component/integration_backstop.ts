import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { deliveryRetryDelay } from "./delivery_policy";
import { syncHandler } from "./integration_remote";

export const SYNC_BACKSTOP_INTERVAL_MS = 600_000;

export async function ensureSyncBackstopScheduled(ctx: MutationCtx): Promise<void> {
  const integration = await currentIntegration(ctx);
  if (integration?.state !== "active") return;
  const job = integration.syncBackstopJobId
    ? await ctx.db.system.get("_scheduled_functions", integration.syncBackstopJobId)
    : null;
  if (job?.state.kind === "pending" || job?.state.kind === "inProgress") return;
  await scheduleNext(ctx, integration);
}

export async function syncBackstopHandler(
  ctx: MutationCtx,
  args: { installationId: string; dueAt: number },
): Promise<void> {
  const integration = await currentIntegration(ctx);
  if (
    integration?.state !== "active" ||
    integration.installationId !== args.installationId ||
    integration.syncBackstopDueAt !== args.dueAt
  )
    return;
  // Schedule durably before the network action, so a failed pull cannot end the chain.
  await scheduleNext(ctx, integration);
  await ctx.scheduler.runAfter(0, internal.integration.checkSync, {
    installationId: integration.installationId,
  });
}

export async function checkSyncHandler(
  ctx: ActionCtx,
  args: { installationId: string },
): Promise<void> {
  const integration = await ctx.runQuery(internal.integration.get, {});
  if (integration?.state !== "active" || integration.installationId !== args.installationId) return;
  await syncHandler(ctx);
}

export async function cancelSyncBackstop(ctx: MutationCtx, integration: Doc<"integrations">) {
  if (integration.syncBackstopJobId) {
    const job = await ctx.db.system.get("_scheduled_functions", integration.syncBackstopJobId);
    if (job?.state.kind === "pending") await ctx.scheduler.cancel(integration.syncBackstopJobId);
  }
  await ctx.db.patch(integration._id, {
    syncBackstopJobId: undefined,
    syncBackstopDueAt: undefined,
  });
}

async function scheduleNext(ctx: MutationCtx, integration: Doc<"integrations">) {
  // Reuse delivery jitter, capped at ten minutes so the backstop has a bounded interval.
  const delay = Math.min(
    SYNC_BACKSTOP_INTERVAL_MS,
    deliveryRetryDelay(`${integration.installationId}:${Date.now()}`, 5),
  );
  const dueAt = Date.now() + delay;
  const jobId = await ctx.scheduler.runAfter(delay, internal.integration.syncBackstop, {
    installationId: integration.installationId,
    dueAt,
  });
  await ctx.db.patch(integration._id, { syncBackstopJobId: jobId, syncBackstopDueAt: dueAt });
}

function currentIntegration(ctx: MutationCtx) {
  return ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
}
