import type { ErrorCode, ErrorResponse } from "@splitch/contracts";
import { ErrorResponseSchema, getRoute, routeRegistry } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { errorDisclosureForKind, errorResponse } from "./evaluation-error-response";

const CLIENT_KEY_EVALUATION_CODES = [
  ...new Set(
    routeRegistry
      .filter(
        (route) =>
          route.owner === "evaluation-api" &&
          (route.auth === "client-key" || route.auth === "data-plane-key"),
      )
      .flatMap((route) => route.errors),
  ),
].sort();

const PUBLIC_EVALUATION_ERROR_BY_CODE: Record<string, ErrorResponse> = {
  UNAUTHORIZED: errorResponse("UNAUTHORIZED", "Client Key or API Key required"),
  CREDENTIAL_REVOKED: errorResponse("CREDENTIAL_REVOKED", "Client Key is revoked"),
  APP_MISMATCH: errorResponse("APP_MISMATCH", "Client Key does not belong to appId"),
  ORIGIN_NOT_ALLOWED: {
    code: "ORIGIN_NOT_ALLOWED",
    message: "origin is not allowed for this Client Key",
    details: {
      origin: "https://app.example",
      hint: "add this origin to the Client Key allow-list or open the key",
    },
  },
  FLAG_NOT_FOUND: errorResponse("FLAG_NOT_FOUND", "no Flag with key checkout-banner"),
  VALIDATION_ERROR: errorResponse(
    "VALIDATION_ERROR",
    "Idempotency-Key is required for Evaluation usage",
  ),
  RATE_LIMITED: errorResponse("RATE_LIMITED", "Client Key rate limit exceeded"),
  SERVICE_UNAVAILABLE: errorResponse(
    "SERVICE_UNAVAILABLE",
    "Evaluation commit ingest is unavailable",
  ),
  INSUFFICIENT_SCOPES: {
    code: "INSUFFICIENT_SCOPES",
    message: "API Key cannot evaluate",
    details: { requiredScopes: ["data-plane:evaluate"], heldScopes: [] },
  },
  UNSUPPORTED_OBJECT_KEY: errorResponse(
    "UNSUPPORTED_OBJECT_KEY",
    'Flag Key "__proto__" cannot be included',
  ),
  EXPOSURE_TICKET_INVALID: {
    code: "EXPOSURE_TICKET_INVALID",
    message: "Exposure Ticket is invalid",
    details: { exposureId: "00000000-0000-4000-8000-000000000001" },
  },
  EXPOSURE_TICKET_EXPIRED: {
    code: "EXPOSURE_TICKET_EXPIRED",
    message: "Exposure Ticket is expired",
    details: {
      exposureId: "00000000-0000-4000-8000-000000000001",
      issuedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  EVENT_ID_CONFLICT: {
    code: "EVENT_ID_CONFLICT",
    message: "eventId was already used for different content",
    details: { eventId: "00000000-0000-4000-8000-000000000001" },
  },
  INTERNAL_SERVER_ERROR: errorResponse(
    "INTERNAL_SERVER_ERROR",
    'Invalid regex condition "(unclosed"',
  ),
};

const PUBLIC_VALIDATION_VARIANTS: readonly ErrorResponse[] = [
  errorResponse("VALIDATION_ERROR", "Idempotency-Key is required for Evaluation usage"),
  errorResponse(
    "VALIDATION_ERROR",
    'Evaluation idType "user" does not match Experiment targetingKeyType "workspace"',
  ),
  errorResponse("VALIDATION_ERROR", 'Invalid regex condition "(unclosed"'),
];

describe("evaluation-error-response public disclosure", () => {
  it("enumerates every Client Key Evaluation error from the route contract", () => {
    expect(CLIENT_KEY_EVALUATION_CODES).toEqual(
      Object.keys(PUBLIC_EVALUATION_ERROR_BY_CODE).sort(),
    );
    expect(getRoute("sdk_evaluate")?.errors).toEqual(
      expect.arrayContaining([
        "UNAUTHORIZED",
        "CREDENTIAL_REVOKED",
        "ORIGIN_NOT_ALLOWED",
        "RATE_LIMITED",
      ]),
    );
    expect(
      CLIENT_KEY_EVALUATION_CODES.map((code) =>
        ErrorResponseSchema.parse(PUBLIC_EVALUATION_ERROR_BY_CODE[code]),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "code": "APP_MISMATCH",
          "details": {},
          "message": "Client Key does not belong to appId",
        },
        {
          "code": "CREDENTIAL_REVOKED",
          "details": {},
          "message": "Client Key is revoked",
        },
        {
          "code": "EVENT_ID_CONFLICT",
          "details": {
            "eventId": "00000000-0000-4000-8000-000000000001",
          },
          "message": "eventId was already used for different content",
        },
        {
          "code": "EXPOSURE_TICKET_EXPIRED",
          "details": {
            "exposureId": "00000000-0000-4000-8000-000000000001",
            "issuedAt": "2026-01-01T00:00:00.000Z",
          },
          "message": "Exposure Ticket is expired",
        },
        {
          "code": "EXPOSURE_TICKET_INVALID",
          "details": {
            "exposureId": "00000000-0000-4000-8000-000000000001",
          },
          "message": "Exposure Ticket is invalid",
        },
        {
          "code": "FLAG_NOT_FOUND",
          "details": {},
          "message": "flag not found",
        },
        {
          "code": "INSUFFICIENT_SCOPES",
          "details": {
            "heldScopes": [],
            "requiredScopes": [
              "data-plane:evaluate",
            ],
          },
          "message": "API Key cannot evaluate",
        },
        {
          "code": "INTERNAL_SERVER_ERROR",
          "details": {},
          "message": "evaluation failed",
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
          "message": "Evaluation commit ingest is unavailable",
        },
        {
          "code": "UNAUTHORIZED",
          "details": {},
          "message": "Client Key or API Key required",
        },
        {
          "code": "UNSUPPORTED_OBJECT_KEY",
          "details": {
            "key": "__proto__",
            "path": [
              "evaluations",
              "__proto__",
            ],
          },
          "message": "Flag Key "__proto__" cannot be included",
        },
        {
          "code": "VALIDATION_ERROR",
          "details": {
            "issues": [],
          },
          "message": "Idempotency-Key is required for Evaluation usage",
        },
      ]
    `);
  });

  it("keeps the public VALIDATION_ERROR variants non-revealing", () => {
    expect(
      PUBLIC_VALIDATION_VARIANTS.map((shape) => ErrorResponseSchema.parse(shape)),
    ).toMatchInlineSnapshot(`
      [
        {
          "code": "VALIDATION_ERROR",
          "details": {
            "issues": [],
          },
          "message": "Idempotency-Key is required for Evaluation usage",
        },
        {
          "code": "VALIDATION_ERROR",
          "details": {
            "issues": [],
          },
          "message": "idType does not match the Experiment",
        },
        {
          "code": "VALIDATION_ERROR",
          "details": {
            "issues": [],
          },
          "message": "request is invalid",
        },
      ]
    `);
  });

  it("never returns a configured regex or Experiment Entity type to a Client Key", () => {
    const leaked: Array<[ErrorCode, string]> = [
      ["INTERNAL_SERVER_ERROR", 'Invalid regex condition "(unclosed"'],
      [
        "VALIDATION_ERROR",
        'Evaluation idType "user" does not match Experiment targetingKeyType "workspace"',
      ],
    ];
    for (const [code, message] of leaked) {
      const body = JSON.stringify(errorResponse(code, message));
      expect(body).not.toContain("(unclosed");
      expect(body).not.toContain("workspace");
      expect(body).not.toContain("targetingKeyType");
    }
  });

  it("keeps trusted VALIDATION_ERROR diagnostics on the API Key path", () => {
    const message =
      'Evaluation idType "user" does not match Experiment targetingKeyType "workspace"';
    expect(errorResponse("VALIDATION_ERROR", message, { disclosure: "trusted" }).message).toBe(
      message,
    );
    expect(errorDisclosureForKind("api-key")).toBe("trusted");
    expect(errorDisclosureForKind("client-key")).toBe("public");
  });
});
