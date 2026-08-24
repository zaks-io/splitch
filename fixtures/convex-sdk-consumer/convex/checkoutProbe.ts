import { v } from "convex/values";
import { query } from "./_generated/server";

/** Fixture-only read proving a failed Evaluation never calls the mutation. */
export const getCheckoutRequest = query({
  args: { targetingKey: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("checkoutRequests"),
      _creationTime: v.number(),
      targetingKey: v.string(),
      experience: v.union(v.literal("new"), v.literal("current")),
      variantName: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("checkoutRequests")
      .withIndex("by_targeting_key", (q) => q.eq("targetingKey", args.targetingKey))
      .unique();
  },
});
