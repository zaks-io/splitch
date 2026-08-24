import { describe, expect, it } from "vitest";
import { CLIENT_KEY, makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

const PATH = "/api/sdk/evaluate";

describe("Evaluation Worker browser CORS", () => {
  it("serves preflight and exposes evaluation metadata to browser SDKs", async () => {
    const { app } = await makeSdkRouteHarness({ liveRun: true });
    const preflight = await app.request(PATH, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, idempotency-key",
      },
    });
    const evaluation = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("idempotency-key");
    expect(evaluation.headers.get("access-control-expose-headers")).toContain("x-run-id");
    expect(evaluation.headers.get("access-control-expose-headers")).toContain("x-reason");
  });
});
