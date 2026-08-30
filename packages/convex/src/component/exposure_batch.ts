import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { env } from "./_generated/server";
import {
  DELIVERY_LEASE_MS,
  DELIVERY_PRIVACY_DEADLINE_MS,
  deliveryRetryDelay,
  isRetryableHttpStatus,
} from "./delivery_policy";
import { commitTimestampIso, makeExposureTerminal } from "./exposure_delivery_state";

export const EXPOSURE_BATCH_MAX_ITEMS = 25;
export const EXPOSURE_BATCH_MAX_BODY_BYTES = 32 * 1024;

type BatchResult = {
  exposureId: string;
  outcome: "accepted" | "retry" | "terminal";
  error?: string;
};

type CandidateResult =
  | { kind: "claimed"; item: ReturnType<typeof deliveryItem> }
  | { kind: "skip" }
  | { kind: "stop" };

export async function ensureExposureDrainScheduled(ctx: MutationCtx, dueAt: number): Promise<void> {
  const integration = await currentIntegration(ctx);
  if (integration?.state !== "active") return;
  const existing = integration.exposureDrainJobId
    ? await ctx.db.system.get("_scheduled_functions", integration.exposureDrainJobId)
    : null;
  if (existing?.state.kind === "inProgress") return;
  if (
    existing?.state.kind === "pending" &&
    integration.exposureDrainDueAt !== undefined &&
    integration.exposureDrainDueAt <= dueAt
  )
    return;
  if (existing?.state.kind === "pending" && integration.exposureDrainJobId)
    await ctx.scheduler.cancel(integration.exposureDrainJobId);
  const jobId = await ctx.scheduler.runAfter(
    Math.max(0, dueAt - Date.now()),
    internal.evaluation.drain,
    {},
  );
  await ctx.db.patch(integration._id, { exposureDrainJobId: jobId, exposureDrainDueAt: dueAt });
}

export async function claimExposureBatchHandler(ctx: MutationCtx) {
  const integration = await currentIntegration(ctx);
  if (integration?.state !== "active") return null;
  await ctx.db.patch(integration._id, {
    exposureDrainJobId: undefined,
    exposureDrainDueAt: undefined,
  });
  const now = Date.now();
  const candidates = await dueCandidates(ctx, now);
  const claimed: Array<ReturnType<typeof deliveryItem>> = [];
  const claimedRows: Doc<"exposureOutbox">[] = [];
  for (const row of candidates) {
    const result = await admitCandidate(ctx, row, now, claimed);
    if (result.kind === "stop") break;
    if (result.kind === "skip") continue;
    claimed.push(result.item);
    claimedRows.push(row);
  }
  if (claimed.length === 0) {
    await scheduleNextExposureDrain(ctx);
    return null;
  }
  const leaseExpiresAt = now + DELIVERY_LEASE_MS;
  for (const row of claimedRows)
    await ctx.db.patch(row._id, { state: "delivering", nextAttemptAt: leaseExpiresAt });
  await ensureExposureDrainScheduled(ctx, leaseExpiresAt);
  return { endpoint: integration.endpoint, rows: claimed, leaseExpiresAt };
}

async function admitCandidate(
  ctx: MutationCtx,
  row: Doc<"exposureOutbox">,
  now: number,
  claimed: Array<ReturnType<typeof deliveryItem>>,
): Promise<CandidateResult> {
  if (now - row.createdAt >= DELIVERY_PRIVACY_DEADLINE_MS) {
    await makeExposureTerminal(ctx, row, "Exposure delivery exceeded the 24-hour privacy deadline");
    return { kind: "skip" };
  }
  if (!row.targetingKey || row.attributesJson === undefined) {
    await makeExposureTerminal(ctx, row, "Exposure delivery payload is unavailable");
    return { kind: "skip" };
  }
  if (await entityIsDeleting(ctx, row)) {
    await ctx.db.patch(row._id, {
      state: "suppressed",
      targetingKeyHash: undefined,
      targetingKey: undefined,
      attributesJson: undefined,
    });
    return { kind: "skip" };
  }
  const item = deliveryItem(row);
  if (requestBodyBytes([...claimed, item]) <= EXPOSURE_BATCH_MAX_BODY_BYTES)
    return { kind: "claimed", item };
  if (claimed.length === 0)
    await makeExposureTerminal(ctx, row, "Exposure exceeds the 32 KiB delivery batch limit");
  return { kind: "stop" };
}

export async function finishExposureBatchHandler(
  ctx: MutationCtx,
  args: { leaseExpiresAt: number; results: BatchResult[] },
): Promise<void> {
  for (const result of args.results) await finishOne(ctx, args.leaseExpiresAt, result);
  await scheduleNextExposureDrain(ctx);
}

export async function drainExposuresHandler(ctx: ActionCtx): Promise<void> {
  const delivery = await ctx.runMutation(internal.evaluation.claimExposureBatch, {});
  if (!delivery) return;
  let results: BatchResult[];
  try {
    const response = await fetch(`${delivery.endpoint}/api/integrations/convex/exposures`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SPLITCH_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ exposures: delivery.rows }),
      redirect: "error",
    });
    results = await batchResultsFromResponse(delivery.rows, response);
  } catch {
    results = delivery.rows.map((row) => ({
      exposureId: row.exposureId,
      outcome: "retry",
      error: "Exposure batch delivery failed",
    }));
  }
  await ctx.runMutation(internal.evaluation.finishExposureBatch, {
    leaseExpiresAt: delivery.leaseExpiresAt,
    results,
  });
}

async function finishOne(ctx: MutationCtx, leaseExpiresAt: number, result: BatchResult) {
  const row = await ctx.db
    .query("exposureOutbox")
    .withIndex("by_exposure", (q) => q.eq("exposureId", result.exposureId))
    .unique();
  if (row?.state !== "delivering" || row.nextAttemptAt !== leaseExpiresAt) return;
  if (result.outcome === "accepted") return ctx.db.delete(row._id);
  if (result.outcome === "terminal") return makeExposureTerminal(ctx, row, result.error);
  if (Date.now() - row.createdAt >= DELIVERY_PRIVACY_DEADLINE_MS)
    return makeExposureTerminal(
      ctx,
      row,
      "Exposure delivery exceeded the 24-hour privacy deadline",
    );
  const attemptCount = row.attemptCount + 1;
  await ctx.db.patch(row._id, {
    state: "pending",
    attemptCount,
    nextAttemptAt: Date.now() + deliveryRetryDelay(row.exposureId, attemptCount),
    lastError: result.error,
  });
}

async function dueCandidates(ctx: MutationCtx, now: number) {
  const due = (state: "pending" | "delivering") =>
    ctx.db
      .query("exposureOutbox")
      .withIndex("by_state_next_attempt", (q) => q.eq("state", state).lte("nextAttemptAt", now))
      .take(EXPOSURE_BATCH_MAX_ITEMS);
  const [pending, expiredLeases] = await Promise.all([due("pending"), due("delivering")]);
  return [...pending, ...expiredLeases]
    .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)
    .slice(0, EXPOSURE_BATCH_MAX_ITEMS);
}

function deliveryItem(row: Doc<"exposureOutbox">) {
  if (!row.targetingKey || row.attributesJson === undefined)
    throw new Error("Exposure delivery payload is unavailable");
  return {
    exposureId: row.exposureId,
    installationId: row.installationId,
    flagKey: row.flagKey,
    experimentId: row.experimentId,
    runId: row.runId,
    runConfigHash: row.runConfigHash,
    evaluationContext: {
      targetingKey: row.targetingKey,
      idType: row.idType,
      attributes: JSON.parse(row.attributesJson) as Record<string, unknown>,
    },
    variantName: row.variantName,
    exposureAt: commitTimestampIso(row.exposedAtCommitTs),
  };
}

function requestBodyBytes(rows: Array<ReturnType<typeof deliveryItem>>): number {
  return new TextEncoder().encode(JSON.stringify({ exposures: rows })).byteLength;
}

async function entityIsDeleting(ctx: MutationCtx, row: Doc<"exposureOutbox">): Promise<boolean> {
  if (!row.targetingKeyHash) return false;
  return (
    (await ctx.db
      .query("entityDeletions")
      .withIndex("by_entity", (q) =>
        q.eq("idType", row.idType).eq("targetingKeyHash", row.targetingKeyHash ?? ""),
      )
      .unique()) !== null
  );
}

async function scheduleNextExposureDrain(ctx: MutationCtx): Promise<void> {
  const first = (state: "pending" | "delivering") =>
    ctx.db
      .query("exposureOutbox")
      .withIndex("by_state_next_attempt", (q) => q.eq("state", state))
      .order("asc")
      .first();
  const [pending, delivering] = await Promise.all([first("pending"), first("delivering")]);
  const dueAt = Math.min(
    pending?.nextAttemptAt ?? Number.POSITIVE_INFINITY,
    delivering?.nextAttemptAt ?? Number.POSITIVE_INFINITY,
  );
  if (Number.isFinite(dueAt)) return ensureExposureDrainScheduled(ctx, dueAt);
  const integration = await currentIntegration(ctx);
  if (!integration) return;
  const scheduled = integration.exposureDrainJobId
    ? await ctx.db.system.get("_scheduled_functions", integration.exposureDrainJobId)
    : null;
  if (scheduled?.state.kind === "pending" && integration.exposureDrainJobId)
    await ctx.scheduler.cancel(integration.exposureDrainJobId);
  await ctx.db.patch(integration._id, {
    exposureDrainJobId: undefined,
    exposureDrainDueAt: undefined,
  });
}

async function batchResultsFromResponse(
  rows: Array<{ exposureId: string }>,
  response: Response,
): Promise<BatchResult[]> {
  if (!response.ok) {
    const outcome = isRetryableHttpStatus(response.status) ? "retry" : "terminal";
    return rows.map((row) => ({
      exposureId: row.exposureId,
      outcome,
      error: `HTTP ${response.status}`,
    }));
  }
  const body = (await response.json()) as {
    results?: Array<{ exposureId?: string; status?: string; retryable?: boolean }>;
  };
  const byId = new Map(body.results?.map((result) => [result.exposureId, result]) ?? []);
  return rows.map((row) => resultFor(row.exposureId, byId.get(row.exposureId)));
}

function resultFor(
  exposureId: string,
  result: { status?: string; retryable?: boolean } | undefined,
): BatchResult {
  if (!result)
    return {
      exposureId,
      outcome: "retry",
      error: "Exposure batch response omitted the item result",
    };
  if (["accepted", "deduplicated", "queued"].includes(result.status ?? ""))
    return { exposureId, outcome: "accepted" };
  return {
    exposureId,
    outcome: result.retryable ? "retry" : "terminal",
    error: "Exposure delivery was rejected",
  };
}

async function currentIntegration(ctx: MutationCtx) {
  return ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
}
