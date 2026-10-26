import type { QueryCtx } from "./_generated/server";

export const CURRENT_KEY = "current" as const;

export function currentIntegration(ctx: Pick<QueryCtx, "db">) {
  return ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", CURRENT_KEY))
    .unique();
}

export async function requiredIntegration(ctx: Pick<QueryCtx, "db">) {
  const integration = await currentIntegration(ctx);
  if (!integration) throw new Error("@splitch/convex is not initialized");
  return integration;
}
