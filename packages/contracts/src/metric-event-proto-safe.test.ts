import { describe, expect, it } from "vitest";
import { MetricEventTrackRequestSchema } from "./metric-event";
import { OWN_PROTO_KEY } from "./proto-safe-record";

const BASE = {
  eventName: "signed_up",
  targetingKey: "entity-7",
  idType: "user",
  eventId: "123e4567-e89b-42d3-a456-426614174000",
  dimensions: {},
};

describe("Metric Event track request proto-safe records", () => {
  it("refuses an own __proto__ fields key instead of silently dropping it", () => {
    const body = JSON.parse(
      JSON.stringify({ ...BASE, fields: { converted: true } }).replace(
        '"converted":true',
        `${JSON.stringify(OWN_PROTO_KEY)}:true`,
      ),
    ) as unknown;
    const parsed = MetricEventTrackRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected refusal");
    expect(parsed.error.issues.some((issue) => issue.path.includes(OWN_PROTO_KEY))).toBe(true);
  });

  it("refuses an own nested __proto__ JSON field instead of admitting an empty object", () => {
    const body = {
      ...BASE,
      fields: { profile: JSON.parse(`{${JSON.stringify(OWN_PROTO_KEY)}:true}`) },
    };
    const parsed = MetricEventTrackRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected refusal");
    expect(parsed.error.issues.some((issue) => issue.path.includes("profile"))).toBe(true);
  });

  it("refuses an own __proto__ dimensions key instead of silently dropping it", () => {
    const body = JSON.parse(
      JSON.stringify({ ...BASE, fields: {}, dimensions: { plan: "pro" } }).replace(
        '"plan":"pro"',
        `${JSON.stringify(OWN_PROTO_KEY)}:"pro"`,
      ),
    ) as unknown;
    const parsed = MetricEventTrackRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected refusal");
    expect(parsed.error.issues.some((issue) => issue.path.includes(OWN_PROTO_KEY))).toBe(true);
  });

  it("still accepts ordinary JSON objects", () => {
    expect(
      MetricEventTrackRequestSchema.parse({
        ...BASE,
        fields: { profile: { plan: "pro" } },
      }).fields,
    ).toEqual({ profile: { plan: "pro" } });
  });
});
