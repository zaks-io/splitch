import {
  clientKeyCacheKey,
  experimentConfigKey,
  flagConfigKey,
  type ErrorResponse,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  API_KEY,
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  LOCKED_CLIENT_KEY,
  REVOKED_CLIENT_KEY,
  UNSCOPED_API_KEY,
  makeSdkRouteHarness,
  sdkRouteInit,
  sha256Hex,
} from "./sdk-route-test-fixtures.js";

const PATH = "/api/sdk/verify";

describe("POST /api/sdk/verify", () => {
  it("returns non-revealing ResolutionDetails under a Client Key", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness();

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({
      value: true,
      variantName: "treatment",
      reason: "SPLIT",
    });
    expect(JSON.stringify(body)).not.toContain("rule-enterprise");
    expect(JSON.stringify(body)).not.toContain("rollout");
    expect(JSON.stringify(body)).not.toContain("salt");
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("returns TARGETING_MATCH with ruleId under an API Key", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness();

    const res = await app.request(PATH, sdkRouteInit(API_KEY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      value: true,
      variantName: "treatment",
      reason: "TARGETING_MATCH",
      ruleId: "rule-enterprise",
    });
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

  it("treats body appId as an assertion and rejects mismatches without data access", async () => {
    const { app, assignmentStore, configKv } = await makeSdkRouteHarness();

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY, {}, { appId: "app-other" }));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(403);
    expect(body.code).toBe("APP_MISMATCH");
    expect(configKv.getCalls).toEqual([]);
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("enforces a Client Key origin allow-list before evaluation", async () => {
    const allowedHarness = await makeSdkRouteHarness();
    const allowed = await allowedHarness.app.request(
      PATH,
      sdkRouteInit(LOCKED_CLIENT_KEY, { origin: "https://app.example.test" }),
    );

    expect(allowed.status).toBe(200);
    expect(allowedHarness.assignmentStore.getAllCalls).toHaveLength(1);
    expect(allowedHarness.assignmentStore.putCalls).toEqual([]);

    const blockedHarness = await makeSdkRouteHarness();
    const blocked = await blockedHarness.app.request(
      PATH,
      sdkRouteInit(LOCKED_CLIENT_KEY, { origin: "https://evil.example.test" }),
    );
    const body = (await blocked.json()) as ErrorResponse;

    expect(blocked.status).toBe(403);
    expect(body).toEqual({
      code: "ORIGIN_NOT_ALLOWED",
      message: "origin is not allowed for this Client Key",
      details: {
        origin: "https://evil.example.test",
        hint: "add this origin to the Client Key allow-list or open the key",
      },
    });
    expect(blockedHarness.assignmentStore.getAllCalls).toEqual([]);
    expect(blockedHarness.assignmentStore.putCalls).toEqual([]);
  });

  it("is repeatable without Assignment Store writes", async () => {
    const { app, assignmentStore, configKv, credentialKv } = await makeSdkRouteHarness();

    await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(assignmentStore.getAllCalls).toHaveLength(2);
    expect(assignmentStore.putCalls).toEqual([]);
    expect(configKv.getCalls).toEqual([
      flagConfigKey(APP_ID, ENVIRONMENT_ID, FLAG_KEY),
      experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
      experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
    ]);
    expect(credentialKv.getCalls).toEqual([
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY)),
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY)),
    ]);
  });

  it("rejects missing and revoked credentials before evaluation", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness();

    const missing = await app.request(PATH, sdkRouteInit());
    const revoked = await app.request(PATH, sdkRouteInit(REVOKED_CLIENT_KEY));

    expect(missing.status).toBe(401);
    expect(((await missing.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(revoked.status).toBe(403);
    expect(((await revoked.json()) as ErrorResponse).code).toBe("CREDENTIAL_REVOKED");
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });
});
