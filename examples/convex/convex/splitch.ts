import { Splitch } from "@splitch/convex";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

const flags = new Splitch(components.splitch);

export const install = action({
  args: {},
  handler: (ctx) => flags.install(ctx),
});

export const sync = action({
  args: {},
  handler: (ctx) => flags.sync(ctx),
});

export const rotateSecret = action({
  args: {},
  handler: (ctx) => flags.rotateSecret(ctx),
});

export const uninstall = action({
  args: {},
  handler: (ctx) => flags.uninstall(ctx),
});

export const peek = query({
  args: { targetingKey: v.string() },
  handler: (ctx, args) =>
    flags.peekDetails(ctx, "shared-preview-smoke", { targetingKey: args.targetingKey }, false),
});

export const evaluate = mutation({
  args: { targetingKey: v.string(), idempotencyKey: v.string() },
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
  handler: (ctx, args) =>
    ctx.db
      .query("checks")
      .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique(),
});
