import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  API_KEY,
  CLIENT_KEY,
  UNSCOPED_API_KEY,
  makeSdkRouteHarness,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";

const PATH = "/api/sdk/peek";

describe("POST /api/sdk/peek", () => {
  it("returns the resolved Variant under an API Key", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness();

    const res = await app.request(PATH, sdkRouteInit(API_KEY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ variant: true });
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("rejects a valid Client Key with INSUFFICIENT_SCOPES", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness();

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(403);
    expect(body.code).toBe("INSUFFICIENT_SCOPES");
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("rejects missing credentials with UNAUTHORIZED", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness();

    const res = await app.request(PATH, sdkRouteInit());
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("treats body appId as an assertion and rejects mismatches without data access", async () => {
    const { app, assignmentStore, configKv } = await makeSdkRouteHarness();

    const res = await app.request(PATH, sdkRouteInit(API_KEY, {}, { appId: "app-other" }));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(403);
    expect(body.code).toBe("APP_MISMATCH");
    expect(configKv.getCalls).toEqual([]);
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("rejects an API Key without data-plane:evaluate before evaluation", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness();

    const res = await app.request(PATH, sdkRouteInit(UNSCOPED_API_KEY));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(403);
    expect(body.code).toBe("INSUFFICIENT_SCOPES");
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it.each([
    ["disabled Flag", { flagOverrides: { enabled: false } }],
    ["no Targeting Rule match", { flagOverrides: { targetingRules: [] } }],
  ])("rejects a Default Variant fallback for %s", async (_caseName, options) => {
    const { app, assignmentStore } = await makeSdkRouteHarness(options);

    const res = await app.request(PATH, sdkRouteInit(API_KEY));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [] },
    });
    expect(body.message).toContain("Default Variant fallback");
    expect(body).not.toHaveProperty("variant");
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("is repeatable without Exposure payloads or Assignment Store writes", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness({ liveRun: true });

    const first = await app.request(PATH, sdkRouteInit(API_KEY));
    const second = await app.request(PATH, sdkRouteInit(API_KEY));
    const firstBody = (await first.json()) as Record<string, unknown>;
    const secondBody = (await second.json()) as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(typeof firstBody.variant).toBe("boolean");
    expect(secondBody).toEqual(firstBody);
    expect(JSON.stringify([firstBody, secondBody])).not.toContain("exposure");
    expect(JSON.stringify([firstBody, secondBody])).not.toContain("reason");
    expect(assignmentStore.getAllCalls).toHaveLength(2);
    expect(assignmentStore.putCalls).toEqual([]);
  });
});
