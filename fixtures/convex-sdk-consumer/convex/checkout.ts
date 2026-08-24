// convex/checkout.ts
import { createSplitchClient } from "@splitch/sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";

type CheckoutDecision = {
  experience: "new" | "current";
  variantName: string | null;
};

const checkoutDecisionValidator = v.object({
  experience: v.union(v.literal("new"), v.literal("current")),
  variantName: v.union(v.string(), v.null()),
});

class FlagEvaluationError extends Error {
  constructor(readonly errorCode: string) {
    super(`new-checkout evaluation failed: ${errorCode}`);
    this.name = "FlagEvaluationError";
  }
}

export const applyCheckoutFlag = internalMutation({
  args: {
    targetingKey: v.string(),
    useNewCheckout: v.boolean(),
    checkoutVariant: v.union(v.string(), v.null()),
  },
  returns: checkoutDecisionValidator,
  handler: async (ctx, args): Promise<CheckoutDecision> => {
    const decision: CheckoutDecision = {
      experience: args.useNewCheckout ? "new" : "current",
      variantName: args.checkoutVariant,
    };
    await ctx.db.insert("checkoutRequests", {
      targetingKey: args.targetingKey,
      ...decision,
    });
    return decision;
  },
});

export const checkout = action({
  args: {
    targetingKey: v.string(),
    idempotencyKey: v.string(),
  },
  returns: checkoutDecisionValidator,
  handler: async (ctx, args): Promise<CheckoutDecision> => {
    const clientKey = process.env.SPLITCH_CLIENT_KEY;
    if (!clientKey) throw new Error("SPLITCH_CLIENT_KEY is required");

    const splitch = createSplitchClient({ clientKey });
    const details = await splitch.evaluateDetails("new-checkout", {
      targetingKey: args.targetingKey,
      idempotencyKey: args.idempotencyKey,
      defaultValue: false,
    });
    if (details.reason === "ERROR") {
      if (!details.errorCode) {
        throw new Error("new-checkout ERROR result is missing errorCode");
      }
      throw new FlagEvaluationError(details.errorCode);
    }
    if (typeof details.value !== "boolean") {
      throw new Error("new-checkout must resolve to a boolean");
    }

    return await ctx.runMutation(internal.checkout.applyCheckoutFlag, {
      targetingKey: args.targetingKey,
      useNewCheckout: details.value,
      checkoutVariant: details.variantName ?? null,
    });
  },
});
