import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "./errors";
import { getRoute } from "./route-registry";

const SDK_TRACK_ERRORS = getRoute("sdk_track")?.errors ?? [];

const PUBLIC_EVENT_ERROR_BY_CODE = {
  UNAUTHORIZED: {
    code: "UNAUTHORIZED",
    message: "Client Key or API Key required",
    details: {},
  },
  CREDENTIAL_REVOKED: {
    code: "CREDENTIAL_REVOKED",
    message: "Client Key is revoked",
    details: {},
  },
  INSUFFICIENT_SCOPES: {
    code: "INSUFFICIENT_SCOPES",
    message: "Client Key cannot write Metric Events",
    details: { requiredScopes: ["data-plane:write"], heldScopes: [] },
  },
  ORIGIN_NOT_ALLOWED: {
    code: "ORIGIN_NOT_ALLOWED",
    message: "origin is not allowed for this Client Key",
    details: {
      origin: "https://app.example",
      hint: "add this origin to the Client Key allow-list or open the key",
    },
  },
  VALIDATION_ERROR: {
    code: "VALIDATION_ERROR",
    message: "Metric Event request is invalid",
    details: { issues: [{ path: ["eventId"], message: "Invalid uuid" }] },
  },
  EVENT_DEFINITION_NOT_FOUND: {
    code: "EVENT_DEFINITION_NOT_FOUND",
    message: "Metric Event Definition not found",
    details: {},
  },
  EVENT_DEFINITION_UNPUBLISHED: {
    code: "EVENT_DEFINITION_UNPUBLISHED",
    message: "Metric Event Definition Version is not published",
    details: { eventName: "signed_up" },
  },
  EVENT_SCHEMA_MISMATCH: {
    code: "EVENT_SCHEMA_MISMATCH",
    message: "Metric Event does not match the Event Definition Version",
    details: {
      eventName: "signed_up",
      issues: [
        { path: ["fields"], message: "invalid value" },
        { path: ["fields", "amount"], message: "number is out of range" },
        { path: ["fields", "profile"], message: "fields key is not declared" },
        { path: ["dimensions", "plan"], message: "value is not allowed" },
      ],
    },
  },
  ENTITY_TYPE_MISMATCH: {
    code: "ENTITY_TYPE_MISMATCH",
    message: "Metric Event Entity type does not match the Event Definition Version",
    details: { receivedIdType: "workspace" },
  },
  EVENT_ID_CONFLICT: {
    code: "EVENT_ID_CONFLICT",
    message: "eventId was already used for different Metric Event content",
    details: { eventId: "123e4567-e89b-42d3-a456-426614174000" },
  },
  RATE_LIMITED: {
    code: "RATE_LIMITED",
    message: "Client Key rate limit exceeded",
    details: { retryAfterMs: 1000 },
  },
  SERVICE_UNAVAILABLE: {
    code: "SERVICE_UNAVAILABLE",
    message: "Metric Event outbox is unavailable",
    details: { retryAfterMs: 1000 },
  },
} as const;

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
  {
    code: "EVENT_DEFINITION_UNPUBLISHED",
    message: "Metric Event Definition Version is not published",
    details: { eventDefinitionId: "ed_signed_up", eventName: "signed_up" },
  },
] as const;

function publicEventError(code: string) {
  if (!(code in PUBLIC_EVENT_ERROR_BY_CODE)) {
    throw new Error(`sdk_track public error shape missing for ${code}`);
  }
  return PUBLIC_EVENT_ERROR_BY_CODE[code as keyof typeof PUBLIC_EVENT_ERROR_BY_CODE];
}

describe("Event Ingest error disclosure contract", () => {
  it("enumerates every public Client Key sdk_track error from the route contract", () => {
    expect(SDK_TRACK_ERRORS).toHaveLength(12);
    expect([...SDK_TRACK_ERRORS].sort()).toEqual(Object.keys(PUBLIC_EVENT_ERROR_BY_CODE).sort());
    expect(
      SDK_TRACK_ERRORS.map((code) => ErrorResponseSchema.parse(publicEventError(code))),
    ).toMatchInlineSnapshot(`
      [
        {
          "code": "UNAUTHORIZED",
          "details": {},
          "message": "Client Key or API Key required",
        },
        {
          "code": "CREDENTIAL_REVOKED",
          "details": {},
          "message": "Client Key is revoked",
        },
        {
          "code": "INSUFFICIENT_SCOPES",
          "details": {
            "heldScopes": [],
            "requiredScopes": [
              "data-plane:write",
            ],
          },
          "message": "Client Key cannot write Metric Events",
        },
        {
          "code": "ORIGIN_NOT_ALLOWED",
          "details": {
            "hint": "add this origin to the Client Key allow-list or open the key",
            "origin": "https://app.example",
          },
          "message": "origin is not allowed for this Client Key",
        },
        {
          "code": "VALIDATION_ERROR",
          "details": {
            "issues": [
              {
                "message": "Invalid uuid",
                "path": [
                  "eventId",
                ],
              },
            ],
          },
          "message": "Metric Event request is invalid",
        },
        {
          "code": "EVENT_DEFINITION_NOT_FOUND",
          "details": {},
          "message": "Metric Event Definition not found",
        },
        {
          "code": "EVENT_DEFINITION_UNPUBLISHED",
          "details": {
            "eventName": "signed_up",
          },
          "message": "Metric Event Definition Version is not published",
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
                ],
              },
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
          "code": "EVENT_ID_CONFLICT",
          "details": {
            "eventId": "123e4567-e89b-42d3-a456-426614174000",
          },
          "message": "eventId was already used for different Metric Event content",
        },
        {
          "code": "RATE_LIMITED",
          "details": {
            "retryAfterMs": 1000,
          },
          "message": "Client Key rate limit exceeded",
        },
        {
          "code": "SERVICE_UNAVAILABLE",
          "details": {
            "retryAfterMs": 1000,
          },
          "message": "Metric Event outbox is unavailable",
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
        {
          "code": "EVENT_DEFINITION_UNPUBLISHED",
          "details": {
            "eventDefinitionId": "ed_signed_up",
            "eventName": "signed_up",
          },
          "message": "Metric Event Definition Version is not published",
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
        issues: [{ path: ["fields"], message: "invalid value" }],
      },
    });
    if (parsed.code !== "EVENT_SCHEMA_MISMATCH") {
      throw new Error("discriminant did not narrow to EVENT_SCHEMA_MISMATCH");
    }
    expect(parsed.details.eventDefinitionVersionId).toBeUndefined();
  });
});
