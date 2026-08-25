import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const RETENTION_MS = 30 * 86_400_000;
const BATCH_SIZE = 100;

export const purgeExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - RETENTION_MS;
    const [legacyEvaluationClaims, evaluationClaims, webhookClaims, terminalExposures] =
      await Promise.all([
        ctx.db
          .query("evaluationClaims")
          .withIndex("by_created_at", (q) => q.eq("createdAt", undefined))
          .take(BATCH_SIZE),
        ctx.db
          .query("evaluationClaims")
          .withIndex("by_created_at", (q) => q.lt("createdAt", cutoff))
          .take(BATCH_SIZE),
        ctx.db
          .query("webhookClaims")
          .withIndex("by_claimed_at", (q) => q.lt("claimedAt", cutoff))
          .take(BATCH_SIZE),
        ctx.db
          .query("exposureOutbox")
          .withIndex("by_state_terminal_at", (q) =>
            q.eq("state", "terminal").lt("terminalAt", cutoff),
          )
          .take(BATCH_SIZE),
      ]);
    for (const row of legacyEvaluationClaims)
      await ctx.db.patch(row._id, { createdAt: row._creationTime });
    const rows = [...evaluationClaims, ...webhookClaims, ...terminalExposures];
    for (const row of rows) await ctx.db.delete(row._id);
    if (
      legacyEvaluationClaims.length === BATCH_SIZE ||
      evaluationClaims.length === BATCH_SIZE ||
      webhookClaims.length === BATCH_SIZE ||
      terminalExposures.length === BATCH_SIZE
    ) {
      await ctx.scheduler.runAfter(0, internal.retention.purgeExpired, {});
    }
    return rows.length;
  },
});
