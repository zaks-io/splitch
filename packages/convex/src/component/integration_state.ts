import type { QueryCtx } from "./_generated/server";

export async function requiredIntegration(ctx: Pick<QueryCtx, "db">) {
  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
  if (!integration) throw new Error("@splitch/convex is not initialized");
  return integration;
}
