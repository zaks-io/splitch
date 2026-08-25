import { Splitch } from "@splitch/convex";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import schema from "./schema";

const flags = new Splitch(components.splitch);
const variantValue = v.union(v.boolean(), v.string(), v.number(), v.record(v.string(), v.any()));
const resolutionDetails = v.object({
  value: variantValue,
  variantName: v.union(v.string(), v.null()),
  reason: v.union(
    v.literal("SPLIT"),
    v.literal("TARGETING_MATCH"),
    v.literal("DEFAULT"),
    v.literal("DISABLED"),
    v.literal("CACHED"),
    v.literal("STALE"),
    v.literal("ERROR"),
  ),
  ruleId: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
});

export const install = action({
  args: {},
  returns: v.object({
    installationId: v.string(),
    appId: v.string(),
    environmentId: v.string(),
    environmentVersion: v.number(),
    status: v.union(v.literal("active"), v.literal("revoked")),
  }),
  handler: (ctx) => flags.install(ctx),
});

export const sync = action({
  args: {},
  returns: v.number(),
  handler: (ctx) => flags.sync(ctx),
});

export const rotateSecret = action({
  args: {},
  returns: v.null(),
  handler: (ctx) => flags.rotateSecret(ctx),
});

export const uninstall = action({
  args: {},
  returns: v.null(),
  handler: (ctx) => flags.uninstall(ctx),
});

export const peek = query({
  args: { targetingKey: v.string() },
  returns: resolutionDetails,
  handler: (ctx, args) =>
    flags.peekDetails(ctx, "shared-preview-smoke", { targetingKey: args.targetingKey }, false),
});

export const reactFlag = query({
  args: { flagKey: v.string(), defaultValue: variantValue },
  returns: resolutionDetails,
  handler: (ctx, args) =>
    flags.peekDetails(ctx, args.flagKey, { targetingKey: "react-dogfood-user" }, args.defaultValue),
});

export const evaluate = mutation({
  args: { targetingKey: v.string(), idempotencyKey: v.string() },
  returns: resolutionDetails,
  handler: async (ctx, args) => {
    const details = await flags.evaluateDetails(
      ctx,
      "shared-preview-smoke",
      { targetingKey: args.targetingKey, idempotencyKey: args.idempotencyKey },
      false,
    );
    if (typeof details.value !== "boolean") {
      throw new Error("shared-preview-smoke must resolve to a boolean");
    }
    await ctx.db.insert("checks", {
      idempotencyKey: args.idempotencyKey,
      targetingKey: args.targetingKey,
      value: details.value,
      variantName: details.variantName,
    });
    return details;
  },
});

export const failAfterEvaluate = mutation({
  args: { targetingKey: v.string(), idempotencyKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await flags.evaluate(
      ctx,
      "shared-preview-smoke",
      { targetingKey: args.targetingKey, idempotencyKey: args.idempotencyKey },
      false,
    );
    throw new Error("intentional rollback probe");
  },
});

export const check = query({
  args: { idempotencyKey: v.string() },
  returns: v.union(schema.doc("checks"), v.null()),
  handler: (ctx, args) =>
    ctx.db
      .query("checks")
      .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique(),
});
