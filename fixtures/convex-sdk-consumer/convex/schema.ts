import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Evaluation results land here after an action calls @splitch/sdk.
 * Queries and mutations never call the SDK (no `fetch` in those function types).
 */
export default defineSchema({
  evaluations: defineTable({
    flagKey: v.string(),
    targetingKey: v.string(),
    value: v.any(),
    variantName: v.union(v.string(), v.null()),
    reason: v.string(),
    errorCode: v.union(v.string(), v.null()),
  }).index("by_targeting_and_flag", ["targetingKey", "flagKey"]),
});
