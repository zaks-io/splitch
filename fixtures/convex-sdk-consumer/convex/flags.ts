import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, query } from "./_generated/server";
import { createExposureClient } from "./client";

const storedResolutionValidator = v.object({
  flagKey: v.string(),
  targetingKey: v.string(),
  value: v.any(),
  variantName: v.union(v.string(), v.null()),
  reason: v.string(),
  errorCode: v.union(v.string(), v.null()),
});

/**
 * Persist a resolution as data. Mutations cannot call `@splitch/sdk`
 * (`fetch` is actions-only: https://docs.convex.dev/functions/runtimes).
 */
export const storeEvaluation = internalMutation({
  args: {
    flagKey: v.string(),
    targetingKey: v.string(),
    value: v.any(),
    variantName: v.union(v.string(), v.null()),
    reason: v.string(),
    errorCode: v.union(v.string(), v.null()),
  },
  returns: v.id("evaluations"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("evaluations", args);
  },
});

/** Read a stored resolution. Queries never call the SDK. */
export const getStoredEvaluation = query({
  args: {
    targetingKey: v.string(),
    flagKey: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("evaluations"),
      _creationTime: v.number(),
      flagKey: v.string(),
      targetingKey: v.string(),
      value: v.any(),
      variantName: v.union(v.string(), v.null()),
      reason: v.string(),
      errorCode: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("evaluations")
      .withIndex("by_targeting_and_flag", (q) =>
        q.eq("targetingKey", args.targetingKey).eq("flagKey", args.flagKey),
      )
      .unique();
  },
});

/**
 * Evaluate a Flag via `@splitch/sdk` inside a Convex action, then store the
 * result for queries/mutations to consume as data.
 *
 * Actions are the function type with `fetch`
 * (https://docs.convex.dev/functions/actions).
 */
export const evaluateAndStore = action({
  args: {
    flagKey: v.string(),
    targetingKey: v.string(),
    idempotencyKey: v.string(),
    defaultValue: v.optional(v.any()),
  },
  returns: storedResolutionValidator,
  handler: async (ctx, args) => {
    const client = createExposureClient();
    const details = await client.evaluateDetails(args.flagKey, {
      targetingKey: args.targetingKey,
      idempotencyKey: args.idempotencyKey,
      defaultValue: args.defaultValue ?? false,
    });
    const stored = {
      flagKey: args.flagKey,
      targetingKey: args.targetingKey,
      value: details.value,
      variantName: details.variantName ?? null,
      reason: details.reason,
      errorCode: details.errorCode ?? null,
    };
    await ctx.runMutation(internal.flags.storeEvaluation, stored);
    return stored;
  },
});

/** Thin evaluate wrapper for round-trip tests without DB writes. */
export const evaluateFlag = action({
  args: {
    flagKey: v.string(),
    targetingKey: v.string(),
    idempotencyKey: v.string(),
    defaultValue: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const client = createExposureClient();
    return await client.evaluate(args.flagKey, {
      targetingKey: args.targetingKey,
      idempotencyKey: args.idempotencyKey,
      defaultValue: args.defaultValue ?? false,
    });
  },
});
