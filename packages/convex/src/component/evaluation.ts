import type { ConvexConfigSnapshot, ResolutionDetails, VariantValue } from "@splitch/contracts";
import { type EvaluateResult, evaluatePath } from "@splitch/evaluation-core";
import { v } from "convex/values";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { canonicalJson, sha256Hex } from "./crypto";
import {
  claimDeliveryHandler,
  deliverHandler,
  finishDeliveryHandler,
  recoverDeliveriesHandler,
} from "./exposure_delivery";
import {
  localTargetingKeyHash,
  persistExposure,
  purgeEntityBatch,
  runtimeState,
} from "./evaluation_state";
import { snapshotProvider } from "./snapshot";
import {
  deliveryClaimValidator,
  evaluationContextValidator,
  resolutionDetailsValidator,
  variantValueValidator,
} from "./validators";

const evaluateArgs = {
  flagKey: v.string(),
  context: evaluationContextValidator,
  defaultValue: variantValueValidator,
};

export const peek = query({
  args: evaluateArgs,
  returns: resolutionDetailsValidator,
  handler: async (ctx, args): Promise<ResolutionDetails> => {
    const runtime = await runtimeState(ctx, args.context);
    const result = await evaluatePath(
      {
        appId: runtime.snapshot.appId,
        environmentId: runtime.snapshot.environmentId,
        flagKey: args.flagKey,
        evaluationContext: args.context,
      },
      {
        provider: snapshotProvider(runtime.snapshot),
        assignmentStore: readOnlyAssignmentStore(runtime.assignments),
      },
    );
    return detailsFor(runtime.snapshot, args.flagKey, result, args.defaultValue);
  },
});

export const evaluate = mutation({
  args: { ...evaluateArgs, idempotencyKey: v.string() },
  returns: resolutionDetailsValidator,
  handler: async (ctx, args): Promise<ResolutionDetails> => {
    if (!args.idempotencyKey)
      throw new Error("idempotencyKey is required for Exposure-bearing Convex evaluation");
    const runtime = await runtimeState(ctx, args.context);
    const fingerprint = await sha256Hex(
      canonicalJson({
        flagKey: args.flagKey,
        context: args.context,
        defaultValue: args.defaultValue,
        snapshotVersion: runtime.snapshot.environmentVersion,
      }),
    );
    const claim = await ctx.db
      .query("evaluationClaims")
      .withIndex("by_key", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (claim) {
      if (claim.fingerprint !== fingerprint)
        throw new Error(
          "IDEMPOTENCY_KEY_CONFLICT: idempotencyKey was reused for a different Convex Evaluation",
        );
      return JSON.parse(claim.result) as ResolutionDetails;
    }
    const result = await evaluatePath(
      {
        appId: runtime.snapshot.appId,
        environmentId: runtime.snapshot.environmentId,
        flagKey: args.flagKey,
        evaluationContext: args.context,
      },
      {
        provider: snapshotProvider(runtime.snapshot),
        assignmentStore: readOnlyAssignmentStore(runtime.assignments),
      },
    );
    const details = detailsFor(runtime.snapshot, args.flagKey, result, args.defaultValue);
    if (result.exposure) await persistExposure(ctx, args, runtime, result.exposure, fingerprint);
    await ctx.db.insert("evaluationClaims", {
      idempotencyKey: args.idempotencyKey,
      fingerprint,
      result: JSON.stringify(details),
      createdAt: Date.now(),
    });
    return details;
  },
});

export const claimDelivery = internalMutation({
  args: { exposureId: v.string() },
  returns: deliveryClaimValidator,
  handler: claimDeliveryHandler,
});

export const finishDelivery = internalMutation({
  args: {
    exposureId: v.string(),
    outcome: v.union(v.literal("accepted"), v.literal("retry"), v.literal("terminal")),
    leaseExpiresAt: v.number(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: finishDeliveryHandler,
});

export const deleteEntity = mutation({
  args: { targetingKey: v.string(), idType: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .unique();
    if (!integration) return;
    const targetingKeyHash = await localTargetingKeyHash(integration.componentIdentityKey, {
      targetingKey: args.targetingKey,
      idType: args.idType,
      attributes: {},
    });
    const existing = await ctx.db
      .query("entityDeletions")
      .withIndex("by_entity", (q) =>
        q.eq("idType", args.idType).eq("targetingKeyHash", targetingKeyHash),
      )
      .unique();
    if (!existing)
      await ctx.db.insert("entityDeletions", { idType: args.idType, targetingKeyHash });
    await purgeEntityBatch(ctx, args.idType, targetingKeyHash);
  },
});

export const continueDeleteEntity = internalMutation({
  args: { idType: v.string(), targetingKeyHash: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    await purgeEntityBatch(ctx, args.idType, args.targetingKeyHash);
  },
});

export const recoverDeliveries = internalMutation({
  args: {},
  returns: v.number(),
  handler: recoverDeliveriesHandler,
});

export const deliver = internalAction({
  args: { exposureId: v.string() },
  returns: v.null(),
  handler: deliverHandler,
});

function readOnlyAssignmentStore(assignments: Map<string, { runId: string; variant: string }>) {
  const noWrite = async () => {
    throw new Error("read-only local Assignment Store");
  };
  return {
    async getAll() {
      return assignments;
    },
    put: noWrite,
    putHashed: noWrite,
  };
}

function detailsFor(
  snapshot: ConvexConfigSnapshot,
  flagKey: string,
  result: EvaluateResult,
  defaultValue: VariantValue,
): ResolutionDetails {
  if (result.kind === "error")
    return {
      value: defaultValue,
      variantName: null,
      reason: "ERROR",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  if (result.variant === null)
    return {
      value: defaultValue,
      variantName: null,
      reason: "ERROR",
      errorCode: "INTERNAL_SERVER_ERROR",
      errorMessage: "Evaluation returned no Variant",
    };
  const flag = snapshot.flags.find((candidate) => candidate.key === flagKey);
  const variant = flag?.variants.find((candidate) => candidate.name === result.variant);
  if (!variant)
    return {
      value: defaultValue,
      variantName: null,
      reason: "ERROR",
      errorCode: "INTERNAL_SERVER_ERROR",
      errorMessage: `Resolved Variant "${result.variant}" is absent from Flag "${flagKey}"`,
    };
  const reason = resolutionReason(result.kind);
  return {
    value: variant.value,
    variantName: variant.name,
    reason,
    ...(reason === "TARGETING_MATCH" &&
    typeof result.reason === "object" &&
    result.reason.type === "rule_matched"
      ? { ruleId: result.reason.ruleId }
      : {}),
  };
}

function resolutionReason(kind: EvaluateResult["kind"]): ResolutionDetails["reason"] {
  if (kind === "disabled") return "DISABLED";
  if (kind === "rule_match_direct" || kind === "rule_match_percentage") return "TARGETING_MATCH";
  if (kind === "holdover_replay") return "CACHED";
  if (kind === "no_match_default" || kind === "no_live_run" || kind === "null_experiment")
    return "DEFAULT";
  return "SPLIT";
}
