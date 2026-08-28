import { describe, expect, it } from "vitest";
import { MetricEventTrackResponseSchema } from "./metric-event";
import { DataPlaneEvaluateResponseSchema } from "./wire-envelopes-core";

describe("public Client Key success shapes", () => {
  it("accepts Client Key track success without Event Definition IDs and keeps them optional", () => {
    const publicSuccess = MetricEventTrackResponseSchema.parse({
      accepted: true,
      duplicate: false,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(publicSuccess).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(publicSuccess.eventDefinitionId).toBeUndefined();
    expect(publicSuccess.eventDefinitionVersionId).toBeUndefined();
    expect(
      MetricEventTrackResponseSchema.parse({
        accepted: true,
        duplicate: true,
        eventId: "123e4567-e89b-42d3-a456-426614174000",
        eventDefinitionId: "ed_signed_up",
        eventDefinitionVersionId: "edv_1",
      }).eventDefinitionId,
    ).toBe("ed_signed_up");
  });

  it("accepts the public evaluate success envelope without extra keys", () => {
    expect(DataPlaneEvaluateResponseSchema.parse({ variant: true })).toEqual({ variant: true });
  });
});
