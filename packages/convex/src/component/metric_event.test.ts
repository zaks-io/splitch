import { describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { validateMetricEvent } from "./metric_event";
import { queueMetricEventHandler } from "./metric_event_state";

const EVENT_ID = "018f7a42-8c11-7c5a-9d4e-123456789abc";
const event = {
  eventName: "model-generation",
  targetingKey: "user_123",
  idType: "user",
  eventId: EVENT_ID,
  fields: { generationCount: 1, usage: { inputTokens: 12 } },
  dimensions: { model: "claude-sonnet" },
};

describe("Convex Metric Event track", () => {
  it("queues one durable delivery with its caller-owned eventId", async () => {
    const { ctx, insert, runAfter } = fakeContext();

    expect(await queueMetricEventHandler(ctx, event)).toEqual({ eventId: EVENT_ID, queued: true });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenNthCalledWith(
      1,
      "metricEventClaims",
      expect.objectContaining({ eventId: EVENT_ID, state: "queued" }),
    );
    expect(insert).toHaveBeenNthCalledWith(
      2,
      "metricEventOutbox",
      expect.objectContaining({
        eventId: EVENT_ID,
        targetingKey: "user_123",
        fieldsJson: JSON.stringify(event.fields),
        dimensionsJson: JSON.stringify(event.dimensions),
        state: "pending",
      }),
    );
    const fingerprint = insert.mock.calls[0]?.[1]?.fingerprint;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(fingerprint).not.toContain(event.targetingKey);
    expect(runAfter).toHaveBeenCalledTimes(2);
    expect(runAfter.mock.calls.map(([delay]) => delay)).toEqual([0, 60_000]);
  });

  it("rejects conflicting reuse of a caller-owned eventId", async () => {
    const first = fakeContext();
    await queueMetricEventHandler(first.ctx, event);
    const fingerprint = first.insert.mock.calls[0]?.[1]?.fingerprint as string;
    const conflicting = fakeContext({ claim: { fingerprint, state: "accepted" } });

    await expect(
      queueMetricEventHandler(conflicting.ctx, {
        ...event,
        fields: { generationCount: 2 },
      }),
    ).rejects.toThrow("EVENT_ID_CONFLICT");
  });

  it("fails loud when an exact replay previously became terminal", async () => {
    const first = fakeContext();
    await queueMetricEventHandler(first.ctx, event);
    const fingerprint = first.insert.mock.calls[0]?.[1]?.fingerprint as string;
    const terminal = fakeContext({
      claim: { fingerprint, state: "terminal", lastError: "EVENT_SCHEMA_MISMATCH" },
    });

    await expect(queueMetricEventHandler(terminal.ctx, event)).rejects.toThrow(
      "EVENT_SCHEMA_MISMATCH",
    );
  });

  it("validates the wire shape before writing", () => {
    expect(() => validateMetricEvent({ ...event, eventId: "not-a-uuid" })).toThrow(
      "eventId must be a lowercase UUID",
    );
    expect(() =>
      validateMetricEvent({ ...event, dimensions: { cost: Number.POSITIVE_INFINITY } }),
    ).toThrow("dimensions.cost must be finite");
    expect(() =>
      validateMetricEvent({
        ...event,
        fields: { bytes: new ArrayBuffer(4) },
      }),
    ).toThrow("fields.bytes must be JSON-compatible");
  });
});

function fakeContext(
  options: {
    claim?: { fingerprint: string; state: "queued" | "accepted" | "terminal"; lastError?: string };
  } = {},
) {
  const insert = vi.fn().mockResolvedValue("inserted");
  const runAfter = vi.fn().mockResolvedValue("scheduled");
  const query = vi.fn((table: string) => ({
    withIndex: vi.fn(() => ({
      unique: vi.fn().mockResolvedValue(
        table === "integrations"
          ? {
              _id: "integration",
              installationId: "installation",
              componentIdentityKey: "identity-secret",
              endpoint: "https://splitch.test",
              state: "active",
            }
          : table === "metricEventClaims"
            ? (options.claim ?? null)
            : null,
      ),
      order: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    })),
  }));
  return {
    ctx: {
      db: {
        query,
        insert,
        system: { get: vi.fn().mockResolvedValue(null) },
      },
      scheduler: { runAfter },
    } as unknown as MutationCtx,
    insert,
    runAfter,
  };
}
