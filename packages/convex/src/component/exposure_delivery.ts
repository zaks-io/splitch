import type { CommitTsPlaceholder } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { env } from "./_generated/server";

const EXPOSURE_PRIVACY_DEADLINE_MS = 86_400_000;
const DELIVERY_LEASE_MS = 60_000;
const RECOVERY_BATCH_SIZE = 25;

export async function claimDeliveryHandler(ctx: MutationCtx, args: { exposureId: string }) {
  const row = await ctx.db
    .query("exposureOutbox")
    .withIndex("by_exposure", (q) => q.eq("exposureId", args.exposureId))
    .unique();
  if (!row || row.state === "accepted" || row.state === "terminal" || row.state === "suppressed")
    return null;
  const now = Date.now();
  if (now - row.createdAt >= EXPOSURE_PRIVACY_DEADLINE_MS) {
    await makeTerminal(ctx, row, "Exposure delivery exceeded the 24-hour privacy deadline");
    return null;
  }
  if (row.nextAttemptAt > now) return null;
  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
  if (integration?.state !== "active" || !row.targetingKey || row.attributesJson === undefined)
    return null;
  if (row.targetingKeyHash) {
    const deletion = await ctx.db
      .query("entityDeletions")
      .withIndex("by_entity", (q) =>
        q.eq("idType", row.idType).eq("targetingKeyHash", row.targetingKeyHash ?? ""),
      )
      .unique();
    if (deletion) {
      await ctx.db.patch(row._id, {
        state: "suppressed",
        targetingKeyHash: undefined,
        targetingKey: undefined,
        attributesJson: undefined,
      });
      return null;
    }
  }
  const leaseExpiresAt = now + DELIVERY_LEASE_MS;
  await ctx.db.patch(row._id, { state: "delivering", nextAttemptAt: leaseExpiresAt });
  return {
    endpoint: integration.endpoint,
    row: {
      exposureId: row.exposureId,
      installationId: row.installationId,
      flagKey: row.flagKey,
      experimentId: row.experimentId,
      runId: row.runId,
      runConfigHash: row.runConfigHash,
      evaluationContext: {
        targetingKey: row.targetingKey,
        idType: row.idType,
        attributes: JSON.parse(row.attributesJson),
      },
      variantName: row.variantName,
      exposureAt: commitTimestampIso(row.exposedAtCommitTs),
    },
    attemptCount: row.attemptCount,
    leaseExpiresAt,
  };
}

export async function finishDeliveryHandler(
  ctx: MutationCtx,
  args: {
    exposureId: string;
    outcome: "accepted" | "retry" | "terminal";
    leaseExpiresAt: number;
    error?: string;
  },
): Promise<void> {
  const row = await ctx.db
    .query("exposureOutbox")
    .withIndex("by_exposure", (q) => q.eq("exposureId", args.exposureId))
    .unique();
  if (row?.state !== "delivering" || row.nextAttemptAt !== args.leaseExpiresAt) return;
  if (args.outcome === "accepted") {
    await ctx.db.delete(row._id);
    return;
  }
  if (args.outcome === "terminal") {
    await makeTerminal(ctx, row, args.error);
    return;
  }
  if (Date.now() - row.createdAt >= EXPOSURE_PRIVACY_DEADLINE_MS) {
    await makeTerminal(ctx, row, "Exposure delivery exceeded the 24-hour privacy deadline");
    return;
  }
  const attemptCount = row.attemptCount + 1;
  const delay = retryDelay(row.exposureId, attemptCount);
  await ctx.db.patch(row._id, {
    state: "pending",
    attemptCount,
    nextAttemptAt: Date.now() + delay,
    lastError: args.error,
  });
  await ctx.scheduler.runAfter(delay, internal.evaluation.deliver, {
    exposureId: args.exposureId,
  });
}

export async function deliverHandler(ctx: ActionCtx, args: { exposureId: string }): Promise<void> {
  const delivery = await ctx.runMutation(internal.evaluation.claimDelivery, args);
  if (!delivery) return;
  try {
    const response = await fetch(`${delivery.endpoint}/api/integrations/convex/exposures`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SPLITCH_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ exposures: [delivery.row] }),
      redirect: "error",
    });
    await finishFromResponse(ctx, args.exposureId, delivery.leaseExpiresAt, response);
  } catch (cause) {
    await ctx.runMutation(internal.evaluation.finishDelivery, {
      exposureId: args.exposureId,
      outcome: "retry",
      leaseExpiresAt: delivery.leaseExpiresAt,
      error: cause instanceof Error ? cause.message : "Exposure delivery failed",
    });
  }
}

async function finishFromResponse(
  ctx: ActionCtx,
  exposureId: string,
  leaseExpiresAt: number,
  response: Response,
): Promise<void> {
  if (!response.ok) {
    const retry = response.status === 408 || response.status === 429 || response.status >= 500;
    await ctx.runMutation(internal.evaluation.finishDelivery, {
      exposureId,
      outcome: retry ? "retry" : "terminal",
      leaseExpiresAt,
      error: `HTTP ${response.status}`,
    });
    return;
  }
  const body = (await response.json()) as {
    results?: Array<{ status: string; retryable?: boolean; message?: string }>;
  };
  const result = body.results?.[0];
  if (!result) throw new Error("Convex Exposure response is missing its item result");
  const outcome =
    result.status === "accepted" || result.status === "deduplicated"
      ? "accepted"
      : result.retryable
        ? "retry"
        : "terminal";
  await ctx.runMutation(internal.evaluation.finishDelivery, {
    exposureId,
    outcome,
    leaseExpiresAt,
    ...(result.message ? { error: result.message } : {}),
  });
}

export async function recoverDeliveriesHandler(ctx: MutationCtx): Promise<number> {
  const now = Date.now();
  const due = (
    await Promise.all(
      (["pending", "delivering"] as const).map((state) =>
        ctx.db
          .query("exposureOutbox")
          .withIndex("by_state_next_attempt", (q) => q.eq("state", state).lte("nextAttemptAt", now))
          .take(RECOVERY_BATCH_SIZE),
      ),
    )
  ).flat();
  for (const row of due) {
    await ctx.scheduler.runAfter(0, internal.evaluation.deliver, { exposureId: row.exposureId });
  }
  return due.length;
}

function commitTimestampIso(value: bigint | CommitTsPlaceholder): string {
  if (typeof value !== "bigint")
    throw new Error("Persisted Convex Exposure has an unresolved commit timestamp");
  return new Date(Number(value / 1_000_000n)).toISOString();
}

async function makeTerminal(
  ctx: MutationCtx,
  row: Doc<"exposureOutbox">,
  error: string | undefined,
): Promise<void> {
  await ctx.db.patch(row._id, {
    state: "terminal",
    targetingKeyHash: undefined,
    targetingKey: undefined,
    attributesJson: undefined,
    terminalAt: Date.now(),
    lastError: error,
  });
}

function retryDelay(exposureId: string, attempt: number): number {
  const delays = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000];
  const base = delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)] ?? 1_800_000;
  const seed = [...`${exposureId}:${attempt}`].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  return Math.round(base * (0.8 + (seed / 0xffffffff) * 0.4));
}
