import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  checks: defineTable({
    idempotencyKey: v.string(),
    targetingKey: v.string(),
    value: v.boolean(),
    variantName: v.union(v.string(), v.null()),
  }).index("by_idempotency_key", ["idempotencyKey"]),
});
