import type { TrackRequest } from "@splitch/sdk";
import { v } from "convex/values";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import {
  claimMetricEventDeliveryHandler,
  deliverMetricEventHandler,
  finishMetricEventDeliveryHandler,
  watchMetricEventDeliveryHandler,
} from "./metric_event_delivery";
import { metricEventStatusHandler, queueMetricEventHandler } from "./metric_event_state";
import {
  metricEventArgsValidator,
  metricEventDeliveryClaimValidator,
  metricEventDeliveryStatusValidator,
  metricEventTrackReceiptValidator,
} from "./validators";

export interface MetricEventTrackReceipt {
  readonly eventId: string;
  readonly queued: true;
}

export interface MetricEventDeliveryStatus {
  readonly eventId: string;
  readonly state: "missing" | "queued" | "accepted" | "terminal" | "suppressed";
  readonly error?: string;
}

export const track = mutation({
  args: metricEventArgsValidator,
  returns: metricEventTrackReceiptValidator,
  handler: async (ctx, args): Promise<MetricEventTrackReceipt> => {
    validateMetricEvent(args);
    return queueMetricEventHandler(ctx, args);
  },
});

export const status = query({
  args: { eventId: v.string() },
  returns: metricEventDeliveryStatusValidator,
  handler: metricEventStatusHandler,
});

export const claimDelivery = internalMutation({
  args: { eventId: v.string() },
  returns: metricEventDeliveryClaimValidator,
  handler: claimMetricEventDeliveryHandler,
});

export const finishDelivery = internalMutation({
  args: {
    eventId: v.string(),
    outcome: v.union(v.literal("accepted"), v.literal("retry"), v.literal("terminal")),
    leaseExpiresAt: v.number(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: finishMetricEventDeliveryHandler,
});

export const watchDelivery = internalMutation({
  args: { eventId: v.string() },
  returns: v.null(),
  handler: watchMetricEventDeliveryHandler,
});

export const deliver = internalAction({
  args: { eventId: v.string() },
  returns: v.null(),
  handler: deliverMetricEventHandler,
});

export function validateMetricEvent(request: TrackRequest): void {
  validateMetricEventIdentity(request);
  validateMetricEventFields(request.fields);
  validateMetricEventDimensions(request.dimensions);
  validateMetricEventBodySize(request);
}

function validateMetricEventIdentity(request: TrackRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(request.eventName))
    throw new Error("VALIDATION_ERROR: eventName must be a 1-64 character telemetry token");
  if (!request.targetingKey) throw new Error("VALIDATION_ERROR: targetingKey is required");
  if (!request.idType) throw new Error("VALIDATION_ERROR: idType is required");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      request.eventId,
    )
  )
    throw new Error("VALIDATION_ERROR: eventId must be a lowercase UUID");
}

function validateMetricEventFields(fields: TrackRequest["fields"]): void {
  for (const [name, value] of Object.entries(fields)) {
    assertJsonValue(value, `fields.${name}`);
  }
}

function validateMetricEventDimensions(dimensions: TrackRequest["dimensions"]): void {
  for (const [name, value] of Object.entries(dimensions)) {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error(`VALIDATION_ERROR: dimensions.${name} must be finite`);
  }
}

function validateMetricEventBodySize(request: TrackRequest): void {
  const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  if (bytes > 32_768)
    throw new Error("VALIDATION_ERROR: Metric Event body exceeds 32768 UTF-8 bytes");
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`VALIDATION_ERROR: ${path} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    assertJsonArray(value, path);
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      assertJsonObject(value as Record<string, unknown>, path);
      return;
    }
  }
  throw new Error(`VALIDATION_ERROR: ${path} must be JSON-compatible`);
}

function assertJsonArray(value: unknown[], path: string): void {
  for (const [index, item] of value.entries()) assertJsonValue(item, `${path}.${index}`);
}

function assertJsonObject(value: Record<string, unknown>, path: string): void {
  for (const [name, child] of Object.entries(value)) assertJsonValue(child, `${path}.${name}`);
}
