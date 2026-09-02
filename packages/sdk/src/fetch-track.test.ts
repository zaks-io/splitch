import { describe, expect, it } from "vitest";
import { postActivation, postMetricEvent, trackFailure } from "./fetch-track";
import { stubFetch } from "./test-fixtures";

const REQUEST = {
  eventName: "signed_up",
  targetingKey: "entity-7",
  idType: "user",
  eventId: "123e4567-e89b-42d3-a456-426614174000",
  fields: { converted: true },
  dimensions: { plan: "pro" },
};

describe("postMetricEvent", () => {
  it("accepts a Client Key 202 that omits Event Definition IDs", async () => {
    const result = await postMetricEvent(
      { credential: "pk_test", fetchImpl: stubFetch(accepted()) },
      new URL("https://edge.test/api/sdk/events"),
      REQUEST,
      new AbortController().signal,
      async () => ({ status: 400, errorCode: "VALIDATION_ERROR", errorMessage: "invalid" }),
    );

    expect(result).toEqual({
      status: 202,
      accepted: true,
      eventId: REQUEST.eventId,
      duplicate: false,
    });
    expect(JSON.stringify(result)).not.toContain("eventDefinitionId");
    expect(JSON.stringify(result)).not.toContain("eventDefinitionVersionId");
  });

  it("does not project Event Definition IDs even when a trusted response includes them", async () => {
    const result = await postMetricEvent(
      {
        credential: "sk_test",
        fetchImpl: stubFetch(
          accepted({
            eventDefinitionId: "ed_signed_up",
            eventDefinitionVersionId: "edv_1",
          }),
        ),
      },
      new URL("https://edge.test/api/sdk/events"),
      REQUEST,
      new AbortController().signal,
      async () => ({ status: 400, errorCode: "VALIDATION_ERROR", errorMessage: "invalid" }),
    );

    expect(result).toEqual({
      status: 202,
      accepted: true,
      eventId: REQUEST.eventId,
      duplicate: false,
    });
    expect(JSON.stringify(result)).not.toContain("ed_signed_up");
    expect(JSON.stringify(result)).not.toContain("edv_1");
  });

  it("does not project Event Definition IDs on a rejected track", () => {
    const result = trackFailure({
      status: 400,
      errorCode: "EVENT_SCHEMA_MISMATCH",
      errorMessage: "Metric Event does not match the Event Definition Version",
    });
    expect(result).toEqual({
      status: 400,
      errorCode: "EVENT_SCHEMA_MISMATCH",
      errorMessage: "Metric Event does not match the Event Definition Version",
      accepted: false,
      eventId: null,
      duplicate: false,
    });
  });
});

describe("postActivation", () => {
  it("returns the number of live Runs activated by one Metric Event", async () => {
    const result = await postActivation(
      { credential: "sk_test", fetchImpl: stubFetch(accepted({ activatedRuns: 2 })) },
      new URL("https://edge.test/api/sdk/activations"),
      REQUEST,
      new AbortController().signal,
      async () => ({ status: 400, errorCode: "VALIDATION_ERROR", errorMessage: "invalid" }),
    );

    expect(result).toMatchObject({
      status: 202,
      accepted: true,
      eventId: REQUEST.eventId,
      duplicate: false,
      activatedRuns: 2,
    });
  });
});

function accepted(extra: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      accepted: true,
      duplicate: false,
      eventId: REQUEST.eventId,
      ...extra,
    },
    { status: 202 },
  );
}
