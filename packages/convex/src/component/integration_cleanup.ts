import { internal } from "./_generated/api";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { env } from "./_generated/server";

export async function revokeLocalHandler(ctx: MutationCtx): Promise<void> {
  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
  if (!integration) throw new Error("@splitch/convex is not initialized");
  await ctx.db.patch(integration._id, { state: "revoked" });
}

export async function purgeBatchHandler(ctx: MutationCtx): Promise<number> {
  const tables = [
    "exposureOutbox",
    "assignments",
    "evaluationClaims",
    "entityDeletions",
    "webhookClaims",
    "snapshots",
    "integrations",
  ] as const;
  for (const table of tables) {
    const rows = await ctx.db.query(table).take(100);
    if (rows.length === 0) continue;
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  }
  return 0;
}

export async function uninstallHandler(ctx: ActionCtx): Promise<void> {
  const integration = await ctx.runQuery(internal.integration.get, {});
  if (!integration) return;
  const response = await fetch(
    `${integration.endpoint}/api/integrations/convex/installations/${integration.installationId}`,
    {
      method: "DELETE",
      headers: uninstallRequestHeaders(),
      redirect: "error",
    },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(`Uninstall Convex integration failed with HTTP ${response.status}`);
  await ctx.runMutation(internal.integration.revokeLocal, {});
  while ((await ctx.runMutation(internal.integration.purgeBatch, {})) > 0) {
    // Each mutation is bounded so large component tables do not exceed Convex write limits.
  }
}

function uninstallRequestHeaders(): Record<string, string> {
  if (!env.SPLITCH_API_KEY) throw new Error("SPLITCH_API_KEY is required for @splitch/convex");
  return { authorization: `Bearer ${env.SPLITCH_API_KEY}`, "content-type": "application/json" };
}
