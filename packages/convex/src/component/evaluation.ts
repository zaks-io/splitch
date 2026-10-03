import {
  type EvaluateResult,
  type EvaluationContext,
  evaluatePath,
  type LocalResolutionDetails as ResolutionDetails,
  type VariantValue,
} from "@splitch/sdk/local-evaluation";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { canonicalJson, sha256Hex } from "./crypto";
import { servedDetails, syncOverdueDetails } from "./evaluation_details";
import {
  localTargetingKeyHash,
  persistExposure,
  purgeEntityBatch,
  type ReadyRuntime,
  runtimeState,
} from "./evaluation_state";
import {
  claimExposureBatchHandler,
  drainExposuresHandler,
  finishExposureBatchHandler,
} from "./exposure_batch";
import {
  claimDeliveryHandler,
  deliverHandler,
  finishDeliveryHandler,
  watchDeliveryHandler,
} from "./exposure_delivery";
import { ensureRetentionScheduled } from "./retention";
import { snapshotProvider } from "./snapshot";
import {
  deliveryBatchClaimValidator,
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

type EvaluateArgs = { flagKey: string; context: EvaluationContext; defaultValue: VariantValue };

export const peek = query({
  args: evaluateArgs,
  returns: resolutionDetailsValidator,
  handler: peekHandler,
});

export const evaluate = mutation({
  args: { ...evaluateArgs, idempotencyKey: v.string() },
  returns: resolutionDetailsValidator,
  handler: evaluateHandler,
});

export async function peekHandler(ctx: QueryCtx, args: EvaluateArgs): Promise<ResolutionDetails> {
  const runtime = await runtimeState(ctx, args.flagKey, args.context);
  if (runtime.kind === "overdue") return syncOverdueDetails(runtime, args.defaultValue);
  return servedDetails(runtime, args, await evaluateHeld(runtime, args));
}

export async function evaluateHandler(
  ctx: MutationCtx,
  args: EvaluateArgs & { idempotencyKey: string },
): Promise<ResolutionDetails> {
  if (!args.idempotencyKey)
    throw new Error("idempotencyKey is required for Exposure-bearing Convex evaluation");
  const runtime = await runtimeState(ctx, args.flagKey, args.context);
  const fingerprint = await sha256Hex(
    canonicalJson({
      flagKey: args.flagKey,
      context: args.context,
      defaultValue: args.defaultValue,
      snapshotVersion:
        runtime.kind === "overdue" ? runtime.snapshotVersion : runtime.snapshot.environmentVersion,
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
    await ensureRetentionScheduled(ctx);
    return JSON.parse(claim.result) as ResolutionDetails;
  }
  // No claim is stored: nothing was served, so a retry after the sync recovers must evaluate fresh.
  if (runtime.kind === "overdue") return syncOverdueDetails(runtime, args.defaultValue);
  const result = await evaluateHeld(runtime, args);
  const details = servedDetails(runtime, args, result);
  if (result.exposure) await persistExposure(ctx, args, runtime, result.exposure, fingerprint);
  await ctx.db.insert("evaluationClaims", {
    idempotencyKey: args.idempotencyKey,
    fingerprint,
    result: JSON.stringify(details),
    createdAt: Date.now(),
  });
  await ensureRetentionScheduled(ctx);
  return details;
}

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

export const claimExposureBatch = internalMutation({
  args: {},
  returns: deliveryBatchClaimValidator,
  handler: claimExposureBatchHandler,
});

export const finishExposureBatch = internalMutation({
  args: {
    leaseExpiresAt: v.number(),
    results: v.array(
      v.object({
        exposureId: v.string(),
        outcome: v.union(v.literal("accepted"), v.literal("retry"), v.literal("terminal")),
        error: v.optional(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: finishExposureBatchHandler,
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

export const watchDelivery = internalMutation({
  args: { exposureId: v.string() },
  returns: v.null(),
  handler: watchDeliveryHandler,
});

export const deliver = internalAction({
  args: { exposureId: v.string() },
  returns: v.null(),
  handler: deliverHandler,
});

export const drain = internalAction({
  args: {},
  returns: v.null(),
  handler: drainExposuresHandler,
});

function evaluateHeld(runtime: ReadyRuntime, args: EvaluateArgs): Promise<EvaluateResult> {
  return evaluatePath(
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
}

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
