import type { ErrorCode, ErrorResponse } from "@splitch/contracts";
import { ErrorResponseSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { errorDisclosureForKind, errorResponse } from "./evaluation-error-response";

const PUBLIC_SHAPES: readonly ErrorResponse[] = [
  errorResponse("FLAG_NOT_FOUND", "no Flag with key checkout-banner"),
  errorResponse("VALIDATION_ERROR", "Idempotency-Key is required for Evaluation usage"),
  errorResponse(
    "VALIDATION_ERROR",
    'Evaluation idType "user" does not match Experiment targetingKeyType "workspace"',
  ),
  errorResponse("VALIDATION_ERROR", 'Invalid regex condition "(unclosed"'),
  errorResponse("UNSUPPORTED_OBJECT_KEY", 'Flag Key "__proto__" cannot be included'),
  errorResponse("INTERNAL_SERVER_ERROR", 'Invalid regex condition "(unclosed"'),
  errorResponse("SERVICE_UNAVAILABLE", "Evaluation commit ingest is unavailable"),
  errorResponse("APP_MISMATCH", "Client Key does not belong to appId"),
];

describe("evaluation-error-response public disclosure", () => {
  it("enumerates every public Client Key error shape", () => {
    expect(PUBLIC_SHAPES.map((shape) => ErrorResponseSchema.parse(shape))).toMatchInlineSnapshot(`
      [
        {
          "code": "FLAG_NOT_FOUND",
          "details": {},
          "message": "flag not found",
        },
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
          "code": "INTERNAL_SERVER_ERROR",
          "details": {},
          "message": "evaluation failed",
        },
        {
          "code": "SERVICE_UNAVAILABLE",
          "details": {
            "retryAfterMs": 1000,
          },
          "message": "Evaluation commit ingest is unavailable",
        },
        {
          "code": "APP_MISMATCH",
          "details": {},
          "message": "Client Key does not belong to appId",
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
