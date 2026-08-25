import type {
  ConvexConfigSnapshot,
  EvaluationContext,
  ResolutionDetails,
  VariantValue,
} from "@splitch/contracts";
import { type EvaluateResult, evaluatePath } from "@splitch/evaluation-core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { canonicalJson, hmacHex, sha256Hex, stableUuid } from "./crypto";
import { deliverHandler, deliveryPayloadHandler, finishDeliveryHandler } from "./exposure_delivery";
import { parseSnapshot, snapshotProvider } from "./snapshot";

const contextValidator = v.object({
  targetingKey: v.string(),
  idType: v.string(),
  attributes: v.record(v.string(), v.any()),
});

const evaluateArgs = {
  flagKey: v.string(),
  context: contextValidator,
  defaultValue: v.any(),
};

export const peek = query({
  args: evaluateArgs,
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
    if (result.exposure) {
      const integration = runtime.integration;
      const run = runtime.snapshot.runs.find(
        (candidate) => candidate.id === result.exposure?.liveRunId,
      );
      if (!run)
        throw new Error(
          `Live Run "${result.exposure.liveRunId}" is absent from the Convex snapshot`,
        );
      const targetingKeyHash = await localTargetingKeyHash(
        integration.componentIdentityKey,
        args.context,
      );
      const existing = await ctx.db
        .query("assignments")
        .withIndex("by_entity_experiment", (q) =>
          q
            .eq("idType", args.context.idType)
            .eq("targetingKeyHash", targetingKeyHash)
            .eq("experimentId", result.exposure?.experimentId ?? ""),
        )
        .unique();
      if (!existing) {
        await ctx.db.insert("assignments", {
          experimentId: result.exposure.experimentId,
          idType: args.context.idType,
          targetingKeyHash,
          runId: result.exposure.liveRunId,
          variant: result.exposure.variant,
        });
      }
      const exposureId = await stableUuid(`${integration.installationId}:${args.idempotencyKey}`);
      await ctx.db.insert("exposureOutbox", {
        exposureId,
        installationId: integration.installationId,
        evaluationFingerprint: fingerprint,
        flagKey: args.flagKey,
        experimentId: result.exposure.experimentId,
        runId: result.exposure.liveRunId,
        runConfigHash: run.configHash,
        idType: args.context.idType,
        targetingKeyHash,
        targetingKey: args.context.targetingKey,
        attributesJson: JSON.stringify(args.context.attributes),
        variantName: result.exposure.variant,
        exposedAtCommitTs: ctx.db.vars.commitTs,
        createdAt: Date.now(),
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.evaluation.deliver, { exposureId });
    }
    await ctx.db.insert("evaluationClaims", {
      idempotencyKey: args.idempotencyKey,
      fingerprint,
      result: JSON.stringify(details),
    });
    return details;
  },
});

export const deliveryPayload = internalQuery({
  args: { exposureId: v.string() },
  handler: deliveryPayloadHandler,
});

export const finishDelivery = internalMutation({
  args: {
    exposureId: v.string(),
    outcome: v.union(v.literal("accepted"), v.literal("retry"), v.literal("terminal")),
    error: v.optional(v.string()),
  },
  handler: finishDeliveryHandler,
});

export const deleteEntity = mutation({
  args: { targetingKey: v.string(), idType: v.string() },
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
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_entity_experiment", (q) =>
        q.eq("idType", args.idType).eq("targetingKeyHash", targetingKeyHash),
      )
      .collect();
    const outbox = await ctx.db
      .query("exposureOutbox")
      .withIndex("by_entity_state", (q) =>
        q.eq("idType", args.idType).eq("targetingKeyHash", targetingKeyHash),
      )
      .collect();
    for (const row of outbox) await ctx.db.delete(row._id);
    for (const row of assignments) await ctx.db.delete(row._id);
  },
});

export const deliver = internalAction({
  args: { exposureId: v.string() },
  handler: deliverHandler,
});

async function runtimeState(ctx: QueryCtx | MutationCtx, context: EvaluationContext) {
  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
  if (integration?.state !== "active" || !integration.appId || !integration.environmentId)
    throw new Error("@splitch/convex is not installed");
  const stored = await ctx.db
    .query("snapshots")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
  if (!stored) throw new Error("PROVIDER_NOT_READY: @splitch/convex has no configuration snapshot");
  if (stored.environmentVersion < integration.announcedVersion)
    throw new Error(
      `STALE: snapshot ${stored.environmentVersion} is behind announced version ${integration.announcedVersion}`,
    );
  const snapshot = parseSnapshot(stored.payload);
  const targetingKeyHash = await localTargetingKeyHash(integration.componentIdentityKey, context);
  const rows = await ctx.db
    .query("assignments")
    .withIndex("by_entity_experiment", (q) =>
      q.eq("idType", context.idType).eq("targetingKeyHash", targetingKeyHash),
    )
    .collect();
  const assignments = new Map<string, { runId: string; variant: string }>(
    rows.map((row) => [row.experimentId, { runId: row.runId, variant: row.variant }]),
  );
  return { integration, snapshot, assignments };
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

async function localTargetingKeyHash(key: string, context: EvaluationContext): Promise<string> {
  return hmacHex(key, `${context.idType}:${context.targetingKey}`);
}
