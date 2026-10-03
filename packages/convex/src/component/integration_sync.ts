import { ConvexConfigSnapshotSchema, parseResponseBody } from "@splitch/sdk/local-evaluation";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import {
  cancelPendingSyncRecovery,
  SYNC_RECOVERY_DELAY_MS,
  scheduleSyncDeadline,
  scheduleSyncRecovery,
} from "./integration_recovery";
import { CURRENT_KEY, requiredIntegration } from "./integration_state";
import { ensureRetentionScheduled } from "./retention";

export async function commitSnapshotHandler(
  ctx: MutationCtx,
  args: { payload: string },
): Promise<void> {
  const snapshot = parseResponseBody(ConvexConfigSnapshotSchema, JSON.parse(args.payload));
  const integration = await requiredIntegration(ctx);
  if (
    integration.appId !== snapshot.appId ||
    integration.environmentId !== snapshot.environmentId
  ) {
    throw new Error("Convex snapshot App or Environment does not match the installation");
  }
  if (snapshot.environmentVersion < integration.announcedVersion) {
    throw new Error(
      `Convex snapshot version ${snapshot.environmentVersion} is below announced version ${integration.announcedVersion}`,
    );
  }
  const existing = await ctx.db
    .query("snapshots")
    .withIndex("by_key", (q) => q.eq("key", CURRENT_KEY))
    .unique();
  if (existing && snapshot.environmentVersion < existing.environmentVersion) {
    throw new Error("Convex snapshot cannot move backwards");
  }
  if (existing)
    await ctx.db.replace(existing._id, {
      key: CURRENT_KEY,
      environmentVersion: snapshot.environmentVersion,
      payload: args.payload,
    });
  else
    await ctx.db.insert("snapshots", {
      key: CURRENT_KEY,
      environmentVersion: snapshot.environmentVersion,
      payload: args.payload,
    });
  await cancelPendingSyncRecovery(ctx, integration);
  await ctx.db.patch(integration._id, {
    snapshotVersion: snapshot.environmentVersion,
    syncRecoveryJobId: undefined,
    syncRecoveryVersion: undefined,
    syncOverdueVersion: undefined,
  });
}

export async function announceHandler(
  ctx: MutationCtx,
  args: { deliveryId: string; appId: string; environmentId: string; environmentVersion: number },
): Promise<"scheduled" | "duplicate"> {
  const integration = await requiredIntegration(ctx);
  if (
    integration.state !== "active" ||
    integration.appId !== args.appId ||
    integration.environmentId !== args.environmentId
  ) {
    throw new Error("Config nudge does not match the active Convex installation");
  }
  const prior = await ctx.db
    .query("webhookClaims")
    .withIndex("by_delivery", (q) => q.eq("deliveryId", args.deliveryId))
    .unique();
  if (prior || args.environmentVersion <= integration.announcedVersion) return "duplicate";
  await ctx.db.insert("webhookClaims", { deliveryId: args.deliveryId, claimedAt: Date.now() });
  await ensureRetentionScheduled(ctx);
  await ctx.db.patch(integration._id, { announcedVersion: args.environmentVersion });
  await ctx.scheduler.runAfter(0, internal.integration.sync, {});
  const announced = { ...integration, announcedVersion: args.environmentVersion };
  await scheduleSyncRecovery(ctx, announced, SYNC_RECOVERY_DELAY_MS);
  await scheduleSyncDeadline(ctx, announced);
  return "scheduled";
}
