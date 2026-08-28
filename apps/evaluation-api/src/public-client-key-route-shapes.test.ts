import type { ErrorResponse } from "@splitch/contracts";
import { ErrorResponseSchema, getRoute, routeRegistry } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  EVALUATION_RATE_LIMIT_RETRY_AFTER_MS,
  makeEvaluationRateLimiter,
} from "./evaluation-rate-limit";
import {
  CLIENT_KEY,
  LOCKED_CLIENT_KEY,
  makeSdkRouteHarness,
  REVOKED_CLIENT_KEY,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";

const CLIENT_KEY_ROUTES = routeRegistry.filter(
  (route) =>
    (route.owner === "evaluation-api" || route.owner === "event-ingest-api") &&
    (route.auth === "client-key" || route.auth === "data-plane-key"),
);

describe("Client Key public route shapes", () => {
  it("derives Evaluation/Event Ingest Client Key routes from the contract registry", () => {
    expect(CLIENT_KEY_ROUTES.map((route) => route.operationId).sort()).toEqual([
      "sdk_cached_evaluation_telemetry",
      "sdk_evaluate",
      "sdk_evaluate_all",
      "sdk_exposures",
      "sdk_track",
      "sdk_verify",
    ]);
    expect(getRoute("sdk_track")?.errors).toEqual(
      expect.arrayContaining(["UNAUTHORIZED", "ORIGIN_NOT_ALLOWED", "RATE_LIMITED"]),
    );
    expect(getRoute("sdk_evaluate")?.errors).toEqual(
      expect.arrayContaining(["UNAUTHORIZED", "ORIGIN_NOT_ALLOWED", "RATE_LIMITED"]),
    );
  });

  it("HTTP-produces evaluate success plus auth, origin, and rate-limit public shapes", async () => {
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });
    const success = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));
    const unauthorized = await app.request("/api/sdk/evaluate", sdkRouteInit());
    const revoked = await app.request("/api/sdk/evaluate", sdkRouteInit(REVOKED_CLIENT_KEY));
    const origin = await app.request(
      "/api/sdk/evaluate",
      sdkRouteInit(LOCKED_CLIENT_KEY, { origin: "https://denied.example" }),
    );

    const { app: limited } = await makeSdkRouteHarness({
      liveRun: true,
      rateLimiter: makeEvaluationRateLimiter({
        limit: async () => ({ success: false }),
      }),
    });
    const rateLimited = await limited.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));

    expect(success.status).toBe(200);
    expect(getRoute("sdk_evaluate")?.output.parse(await success.json())).toEqual({
      variant: true,
    });
    expect(ErrorResponseSchema.parse(await unauthorized.json()).code).toBe("UNAUTHORIZED");
    expect(ErrorResponseSchema.parse(await revoked.json()).code).toBe("CREDENTIAL_REVOKED");
    const originBody = ErrorResponseSchema.parse(await origin.json());
    expect(originBody).toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      details: { origin: "https://denied.example" },
    });
    const rateBody = ErrorResponseSchema.parse(await rateLimited.json());
    expect(rateBody).toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterMs: EVALUATION_RATE_LIMIT_RETRY_AFTER_MS },
    });
    for (const body of [originBody, rateBody]) {
      expect(JSON.stringify(body)).not.toContain(CLIENT_KEY);
      expect(JSON.stringify(body)).not.toContain("eventDefinitionId");
    }
  });

  it("rejects a disallowed origin on sdk_track before Event Ingest sees the request", async () => {
    const forwarded: Request[] = [];
    const { app } = await makeSdkRouteHarness({
      delegationBindings: {
        "event-ingest-api": {
          async fetch(input: RequestInfo | URL) {
            forwarded.push(input as Request);
            return Response.json({ accepted: true }, { status: 202 });
          },
        },
      },
    });

    const response = await app.request("/api/sdk/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${LOCKED_CLIENT_KEY}`,
        "content-type": "application/json",
        origin: "https://denied.example",
      },
      body: JSON.stringify({
        eventName: "signed_up",
        targetingKey: "entity-7",
        idType: "user",
        eventId: "123e4567-e89b-42d3-a456-426614174000",
        fields: { converted: true },
        dimensions: { plan: "pro" },
      }),
    });
    const body = ErrorResponseSchema.parse((await response.json()) as ErrorResponse);

    expect(body.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(body.details).toMatchObject({ origin: "https://denied.example" });
    expect(getRoute("sdk_track")?.errors).toContain("ORIGIN_NOT_ALLOWED");
    expect(forwarded).toHaveLength(0);
  });
});
