import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "./errors";

const PUBLIC_EVENT_ERROR_SHAPES = [
  {
    code: "EVENT_SCHEMA_MISMATCH",
    message: "Metric Event does not match the Event Definition Version",
    details: {
      eventName: "signed_up",
      issues: [
        { path: ["fields", "amount"], message: "number is out of range" },
        { path: ["fields", "profile"], message: "fields key is not declared" },
        { path: ["dimensions", "plan"], message: "value is not allowed" },
      ],
    },
  },
  {
    code: "ENTITY_TYPE_MISMATCH",
    message: "Metric Event Entity type does not match the Event Definition Version",
    details: { receivedIdType: "workspace" },
  },
  {
    code: "EVENT_DEFINITION_NOT_FOUND",
    message: "Metric Event Definition not found",
    details: {},
  },
] as const;

const TRUSTED_EVENT_ERROR_SHAPES = [
  {
    code: "EVENT_SCHEMA_MISMATCH",
    message: "Metric Event does not match the Event Definition Version",
    details: {
      eventName: "signed_up",
      eventDefinitionVersionId: "edv_1",
      issues: [{ path: ["fields", "amount"], message: "number must be at least 10" }],
    },
  },
  {
    code: "ENTITY_TYPE_MISMATCH",
    message: "Metric Event Entity type does not match the Event Definition Version",
    details: {
      expectedIdType: "user",
      receivedIdType: "workspace",
      eventDefinitionId: "ed_signed_up",
    },
  },
] as const;

describe("Event Ingest error disclosure contract", () => {
  it("enumerates every public Client Key Event Ingest error shape", () => {
    expect(
      PUBLIC_EVENT_ERROR_SHAPES.map((shape) => ErrorResponseSchema.parse(shape)),
    ).toMatchInlineSnapshot(`
      [
        {
          "code": "EVENT_SCHEMA_MISMATCH",
          "details": {
            "eventName": "signed_up",
            "issues": [
              {
                "message": "number is out of range",
                "path": [
                  "fields",
                  "amount",
                ],
              },
              {
                "message": "fields key is not declared",
                "path": [
                  "fields",
                  "profile",
                ],
              },
              {
                "message": "value is not allowed",
                "path": [
                  "dimensions",
                  "plan",
                ],
              },
            ],
          },
          "message": "Metric Event does not match the Event Definition Version",
        },
        {
          "code": "ENTITY_TYPE_MISMATCH",
          "details": {
            "receivedIdType": "workspace",
          },
          "message": "Metric Event Entity type does not match the Event Definition Version",
        },
        {
          "code": "EVENT_DEFINITION_NOT_FOUND",
          "details": {},
          "message": "Metric Event Definition not found",
        },
      ]
    `);
  });

  it("keeps trusted Event Definition diagnostics optional on the contract", () => {
    expect(
      TRUSTED_EVENT_ERROR_SHAPES.map((shape) => ErrorResponseSchema.parse(shape)),
    ).toMatchInlineSnapshot(`
      [
        {
          "code": "EVENT_SCHEMA_MISMATCH",
          "details": {
            "eventDefinitionVersionId": "edv_1",
            "eventName": "signed_up",
            "issues": [
              {
                "message": "number must be at least 10",
                "path": [
                  "fields",
                  "amount",
                ],
              },
            ],
          },
          "message": "Metric Event does not match the Event Definition Version",
        },
        {
          "code": "ENTITY_TYPE_MISMATCH",
          "details": {
            "eventDefinitionId": "ed_signed_up",
            "expectedIdType": "user",
            "receivedIdType": "workspace",
          },
          "message": "Metric Event Entity type does not match the Event Definition Version",
        },
      ]
    `);
  });

  it("rejects a public-shaped schema mismatch that still names a Version ID as required", () => {
    const parsed = ErrorResponseSchema.parse({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: "signed_up",
        issues: [{ path: ["fields", "amount"], message: "number is out of range" }],
      },
    });
    if (parsed.code !== "EVENT_SCHEMA_MISMATCH") {
      throw new Error("discriminant did not narrow to EVENT_SCHEMA_MISMATCH");
    }
    expect(parsed.details.eventDefinitionVersionId).toBeUndefined();
  });
});
