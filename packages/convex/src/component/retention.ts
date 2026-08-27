import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";

const RETENTION_MS = 30 * 86_400_000;
const BATCH_SIZE = 100;

export const purgeExpired = internalMutation({
  args: { dueAt: v.number() },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const integration = await currentIntegration(ctx);
    if (!integration || integration.retentionDueAt !== args.dueAt) return 0;
    await ctx.db.patch(integration._id, {
      retentionJobId: undefined,
      retentionDueAt: undefined,
    });
    const purged = await purgeExpiredHandler(ctx);
    await ensureRetentionScheduled(ctx);
    return purged;
  },
});

export async function ensureRetentionScheduled(ctx: MutationCtx): Promise<void> {
  const integration = await currentIntegration(ctx);
  if (!integration) return;
  const existingJob = integration.retentionJobId
    ? await ctx.db.system.get("_scheduled_functions", integration.retentionJobId)
    : null;
  const existingJobIsActive =
    existingJob?.state.kind === "pending" || existingJob?.state.kind === "inProgress";
  if (existingJobIsActive) return;

  const dueAt = await nextRetentionDueAt(ctx);
  if (dueAt === null) return;

  const jobId = await ctx.scheduler.runAfter(
    Math.max(0, dueAt - Date.now()),
    internal.retention.purgeExpired,
    { dueAt },
  );
  await ctx.db.patch(integration._id, { retentionJobId: jobId, retentionDueAt: dueAt });
}

async function purgeExpiredHandler(ctx: MutationCtx): Promise<number> {
  const cutoff = Date.now() - RETENTION_MS;
  const [legacyEvaluationClaims, evaluationClaims, webhookClaims, terminalExposures] =
    await Promise.all([
      ctx.db
        .query("evaluationClaims")
        .withIndex("by_created_at", (q) => q.eq("createdAt", undefined))
        .take(BATCH_SIZE),
      ctx.db
        .query("evaluationClaims")
        .withIndex("by_created_at", (q) => q.lte("createdAt", cutoff))
        .take(BATCH_SIZE),
      ctx.db
        .query("webhookClaims")
        .withIndex("by_claimed_at", (q) => q.lte("claimedAt", cutoff))
        .take(BATCH_SIZE),
      ctx.db
        .query("exposureOutbox")
        .withIndex("by_state_terminal_at", (q) =>
          q.eq("state", "terminal").lte("terminalAt", cutoff),
        )
        .take(BATCH_SIZE),
    ]);
  for (const row of legacyEvaluationClaims)
    await ctx.db.patch(row._id, { createdAt: row._creationTime });
  const rows = [...evaluationClaims, ...webhookClaims, ...terminalExposures];
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

async function nextRetentionDueAt(ctx: MutationCtx): Promise<number | null> {
  const [evaluationClaim, webhookClaim, terminalExposure] = await Promise.all([
    ctx.db.query("evaluationClaims").withIndex("by_created_at").order("asc").first(),
    ctx.db.query("webhookClaims").withIndex("by_claimed_at").order("asc").first(),
    ctx.db
      .query("exposureOutbox")
      .withIndex("by_state_terminal_at", (q) => q.eq("state", "terminal"))
      .order("asc")
      .first(),
  ]);
  if (terminalExposure && terminalExposure.terminalAt === undefined)
    throw new Error("Terminal Convex Exposure is missing terminalAt");
  const terminalDueAt = terminalExposure?.terminalAt;
  const due = [
    evaluationClaim
      ? evaluationClaim.createdAt === undefined
        ? 0
        : evaluationClaim.createdAt + RETENTION_MS
      : null,
    webhookClaim ? webhookClaim.claimedAt + RETENTION_MS : null,
    terminalDueAt === undefined ? null : terminalDueAt + RETENTION_MS,
  ].filter((value): value is number => value !== null);
  return due.length === 0 ? null : Math.min(...due);
}

async function currentIntegration(ctx: MutationCtx) {
  return ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
}
