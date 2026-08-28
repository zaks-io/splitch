import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "./errors";
import { MetricEventTrackResponseSchema } from "./metric-event";

const PUBLIC_EVENT_SUCCESS_SHAPE = {
  accepted: true as const,
  duplicate: false,
  eventId: "123e4567-e89b-42d3-a456-426614174000",
};

const TRUSTED_EVENT_SUCCESS_SHAPE = {
  ...PUBLIC_EVENT_SUCCESS_SHAPE,
  eventDefinitionId: "ed_signed_up",
  eventDefinitionVersionId: "edv_1",
};

const PUBLIC_MISSING_REQUIRED = {
  code: "EVENT_SCHEMA_MISMATCH" as const,
  message: "Metric Event does not match the Event Definition Version",
  details: {
    eventName: "signed_up",
    issues: [{ path: ["fields"], message: "invalid value" }],
  },
};

const PUBLIC_TYPE_INVALID = {
  code: "EVENT_SCHEMA_MISMATCH" as const,
  message: "Metric Event does not match the Event Definition Version",
  details: {
    eventName: "signed_up",
    issues: [{ path: ["fields", "converted"], message: "invalid value" }],
  },
};

describe("Event Ingest public success and schema-probe shapes", () => {
  it("enumerates the public Client Key success shape without internal IDs", () => {
    expect(MetricEventTrackResponseSchema.parse(PUBLIC_EVENT_SUCCESS_SHAPE)).toMatchInlineSnapshot(`
      {
        "accepted": true,
        "duplicate": false,
        "eventId": "123e4567-e89b-42d3-a456-426614174000",
      }
    `);
    expect(PUBLIC_EVENT_SUCCESS_SHAPE).not.toHaveProperty("eventDefinitionId");
    expect(PUBLIC_EVENT_SUCCESS_SHAPE).not.toHaveProperty("eventDefinitionVersionId");
  });

  it("keeps Event Definition IDs optional on the trusted success contract", () => {
    expect(MetricEventTrackResponseSchema.parse(TRUSTED_EVENT_SUCCESS_SHAPE)).toMatchObject(
      TRUSTED_EVENT_SUCCESS_SHAPE,
    );
  });

  it("enumerates missing-required and type-invalid public schema mismatches", () => {
    expect(
      [PUBLIC_MISSING_REQUIRED, PUBLIC_TYPE_INVALID].map((shape) =>
        ErrorResponseSchema.parse(shape),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "code": "EVENT_SCHEMA_MISMATCH",
          "details": {
            "eventName": "signed_up",
            "issues": [
              {
                "message": "invalid value",
                "path": [
                  "fields",
                ],
              },
            ],
          },
          "message": "Metric Event does not match the Event Definition Version",
        },
        {
          "code": "EVENT_SCHEMA_MISMATCH",
          "details": {
            "eventName": "signed_up",
            "issues": [
              {
                "message": "invalid value",
                "path": [
                  "fields",
                  "converted",
                ],
              },
            ],
          },
          "message": "Metric Event does not match the Event Definition Version",
        },
      ]
    `);
    for (const raw of [PUBLIC_MISSING_REQUIRED, PUBLIC_TYPE_INVALID].map((shape) =>
      JSON.stringify(shape),
    )) {
      expect(raw).not.toContain("internal_purchase_limit");
      expect(raw).not.toContain("required value is missing");
      expect(raw).not.toContain("expected boolean");
      expect(raw).not.toContain("edv_1");
    }
  });
});
