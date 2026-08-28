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
import { ensureRetentionScheduled } from "./retention";

type MetricEventFieldValue = boolean | string | number | null | unknown[] | Record<string, unknown>;

const SAFE_METRIC_EVENT_ERRORS = {
  UNAUTHORIZED: { status: 401, message: "Metric Event credential was rejected" },
  CREDENTIAL_REVOKED: { status: 403, message: "Metric Event credential is revoked" },
  INSUFFICIENT_SCOPES: { status: 403, message: "Metric Event credential cannot write events" },
  ORIGIN_NOT_ALLOWED: { status: 403, message: "Metric Event origin is not allowed" },
  VALIDATION_ERROR: { status: 400, message: "Metric Event request is invalid" },
  EVENT_DEFINITION_NOT_FOUND: { status: 404, message: "Metric Event Definition not found" },
  EVENT_DEFINITION_UNPUBLISHED: {
    status: 409,
    message: "Metric Event Definition Version is not published",
  },
  EVENT_SCHEMA_MISMATCH: {
    status: 400,
    message: "Metric Event does not match the Event Definition Version",
  },
  ENTITY_TYPE_MISMATCH: {
    status: 400,
    message: "Metric Event Entity type does not match the Event Definition Version",
  },
  EVENT_ID_CONFLICT: { status: 409, message: "Metric Event eventId conflicts with prior content" },
  RATE_LIMITED: { status: 429, message: "Metric Event ingest is rate limited" },
  SERVICE_UNAVAILABLE: { status: 503, message: "Metric Event ingest is unavailable" },
} as const;

export async function scheduleMetricEventDeliveryWatch(
  ctx: MutationCtx,
  eventId: string,
  delayMs: number,
): Promise<void> {
  await ctx.scheduler.runAfter(delayMs, internal.metric_event.watchDelivery, { eventId });
}

export async function claimMetricEventDeliveryHandler(ctx: MutationCtx, args: { eventId: string }) {
  const row = await metricEventRow(ctx, args.eventId);
  if (!row) return null;
  const now = Date.now();
  if (now - row.createdAt >= DELIVERY_PRIVACY_DEADLINE_MS) {
    await makeTerminal(ctx, row, "Metric Event delivery exceeded the 24-hour privacy deadline");
    return null;
  }
  if (row.nextAttemptAt > now) return null;
  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", "current"))
    .unique();
  if (
    integration?.state !== "active" ||
    !row.targetingKey ||
    row.fieldsJson === undefined ||
    row.dimensionsJson === undefined
  )
    return null;
  if (row.targetingKeyHash) {
    const deletion = await ctx.db
      .query("entityDeletions")
      .withIndex("by_entity", (q) =>
        q.eq("idType", row.idType).eq("targetingKeyHash", row.targetingKeyHash ?? ""),
      )
      .unique();
    if (deletion) {
      await suppress(ctx, row);
      return null;
    }
  }
  const leaseExpiresAt = now + DELIVERY_LEASE_MS;
  await ctx.db.patch(row._id, { state: "delivering", nextAttemptAt: leaseExpiresAt });
  return {
    endpoint: integration.endpoint,
    request: {
      eventName: row.eventName,
      targetingKey: row.targetingKey,
      idType: row.idType,
      eventId: row.eventId,
      fields: JSON.parse(row.fieldsJson) as Record<string, MetricEventFieldValue>,
      dimensions: JSON.parse(row.dimensionsJson) as Record<string, boolean | string | number>,
    },
    leaseExpiresAt,
  };
}

export async function finishMetricEventDeliveryHandler(
  ctx: MutationCtx,
  args: {
    eventId: string;
    outcome: "accepted" | "retry" | "terminal";
    leaseExpiresAt: number;
    error?: string;
  },
): Promise<void> {
  const row = await metricEventRow(ctx, args.eventId);
  if (row?.state !== "delivering" || row.nextAttemptAt !== args.leaseExpiresAt) return;
  if (args.outcome === "accepted") {
    await completeClaim(ctx, row.eventId, "accepted");
    await ctx.db.delete(row._id);
    return;
  }
  if (args.outcome === "terminal") {
    await makeTerminal(ctx, row, args.error);
    return;
  }
  if (Date.now() - row.createdAt >= DELIVERY_PRIVACY_DEADLINE_MS) {
    await makeTerminal(ctx, row, "Metric Event delivery exceeded the 24-hour privacy deadline");
    return;
  }
  const now = Date.now();
  const privacyDeadlineAt = row.createdAt + DELIVERY_PRIVACY_DEADLINE_MS;
  const attemptCount = row.attemptCount + 1;
  const delay = deliveryRetryDelay(row.eventId, attemptCount);
  const nextAttemptAt = Math.min(now + delay, privacyDeadlineAt);
  await ctx.db.patch(row._id, {
    state: "pending",
    attemptCount,
    nextAttemptAt,
    lastError: args.error,
  });
  await ctx.scheduler.runAfter(nextAttemptAt - now, internal.metric_event.deliver, {
    eventId: row.eventId,
  });
}

export async function deliverMetricEventHandler(
  ctx: ActionCtx,
  args: { eventId: string },
): Promise<void> {
  const delivery = await ctx.runMutation(internal.metric_event.claimDelivery, args);
  if (!delivery) return;
  try {
    const response = await fetch(`${delivery.endpoint}/api/sdk/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SPLITCH_API_KEY}`,
        "content-type": "application/json",
        "x-splitch-sdk-runtime": "javascript",
      },
      body: JSON.stringify(delivery.request),
      redirect: "error",
    });
    await finishFromResponse(ctx, args.eventId, delivery.leaseExpiresAt, response);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : "Metric Event delivery failed";
    await ctx.runMutation(internal.metric_event.finishDelivery, {
      eventId: args.eventId,
      outcome: "retry",
      leaseExpiresAt: delivery.leaseExpiresAt,
      error,
    });
  }
}

async function finishFromResponse(
  ctx: ActionCtx,
  eventId: string,
  leaseExpiresAt: number,
  response: Response,
): Promise<void> {
  if (!response.ok) {
    const error = await responseError(response);
    const outcome = isRetryableHttpStatus(response.status) ? "retry" : "terminal";
    await ctx.runMutation(internal.metric_event.finishDelivery, {
      eventId,
      outcome,
      leaseExpiresAt,
      error,
    });
    return;
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body.accepted !== true || body.eventId !== eventId || typeof body.duplicate !== "boolean") {
    throw new Error("Metric Event response did not match the track contract");
  }
  await ctx.runMutation(internal.metric_event.finishDelivery, {
    eventId,
    outcome: "accepted",
    leaseExpiresAt,
  });
}

export async function watchMetricEventDeliveryHandler(
  ctx: MutationCtx,
  args: { eventId: string },
): Promise<void> {
  const row = await metricEventRow(ctx, args.eventId);
  if (!row) return;
  const now = Date.now();
  const privacyDeadlineAt = row.createdAt + DELIVERY_PRIVACY_DEADLINE_MS;
  if (now >= privacyDeadlineAt) {
    await makeTerminal(ctx, row, "Metric Event delivery exceeded the 24-hour privacy deadline");
    return;
  }
  if (row.nextAttemptAt <= now) {
    await ctx.scheduler.runAfter(0, internal.metric_event.deliver, args);
    await scheduleMetricEventDeliveryWatch(
      ctx,
      args.eventId,
      Math.min(DELIVERY_LEASE_MS, privacyDeadlineAt - now),
    );
    return;
  }
  const grace = row.state === "pending" ? DELIVERY_LEASE_MS : 0;
  const nextWatchAt = Math.min(row.nextAttemptAt + grace, privacyDeadlineAt);
  await scheduleMetricEventDeliveryWatch(ctx, args.eventId, nextWatchAt - now);
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown };
    if (typeof body.code === "string" && Object.hasOwn(SAFE_METRIC_EVENT_ERRORS, body.code)) {
      const code = body.code as keyof typeof SAFE_METRIC_EVENT_ERRORS;
      const safeError = SAFE_METRIC_EVENT_ERRORS[code];
      if (safeError.status === response.status)
        return `HTTP ${response.status} ${code}: ${safeError.message}`;
    }
  } catch {
    // The HTTP status remains an actionable, privacy-safe failure signal.
  }
  return `HTTP ${response.status}`;
}

async function metricEventRow(ctx: MutationCtx, eventId: string) {
  return ctx.db
    .query("metricEventOutbox")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .unique();
}

async function suppress(ctx: MutationCtx, row: Doc<"metricEventOutbox">): Promise<void> {
  await completeClaim(ctx, row.eventId, "suppressed", "Entity deletion suppressed delivery");
  await ctx.db.delete(row._id);
}

async function makeTerminal(
  ctx: MutationCtx,
  row: Doc<"metricEventOutbox">,
  error: string | undefined,
): Promise<void> {
  await completeClaim(ctx, row.eventId, "terminal", error);
  await ctx.db.delete(row._id);
  console.error("Splitch Metric Event delivery stopped", {
    eventId: row.eventId,
    error: error ?? "Metric Event delivery stopped",
  });
}

async function completeClaim(
  ctx: MutationCtx,
  eventId: string,
  state: "accepted" | "terminal" | "suppressed",
  error?: string,
): Promise<void> {
  const claim = await ctx.db
    .query("metricEventClaims")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .unique();
  if (!claim) throw new Error(`Metric Event "${eventId}" is missing its idempotency claim`);
  await ctx.db.patch(claim._id, {
    state,
    completedAt: Date.now(),
    lastError: error,
  });
  await ensureRetentionScheduled(ctx);
}
