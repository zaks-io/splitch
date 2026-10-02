import { flagConfigKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { flagConfigKV } from "../provider/fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  FLAG_KEY,
  makeSdkRouteHarness,
} from "../sdk-route-test-fixtures";
import { ofrepInit } from "./public-shapes";

const SINGLE = `/ofrep/v1/evaluate/flags/${FLAG_KEY}`;
const BULK = "/ofrep/v1/evaluate/flags";

describe("OFREP Core request/response shapes", () => {
  it("evaluates one Flag with value, variant, and an OFREP reason", async () => {
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const response = await app.request(SINGLE, ofrepInit(CLIENT_KEY));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      key: FLAG_KEY,
      value: true,
      reason: "SPLIT",
      variant: "treatment",
    });
    expect(body).not.toHaveProperty("errorCode");
  });

  it("accepts X-API-Key as the OFREP credential header", async () => {
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const response = await app.request(SINGLE, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": CLIENT_KEY },
      body: JSON.stringify({ context: { targetingKey: "user-1" } }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ key: FLAG_KEY, reason: "SPLIT" });
  });

  it("maps a missing targetingKey to 400 TARGETING_KEY_MISSING", async () => {
    const { app } = await makeSdkRouteHarness();

    const response = await app.request(SINGLE, ofrepInit(CLIENT_KEY, {}, {}));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      key: FLAG_KEY,
      errorCode: "TARGETING_KEY_MISSING",
      errorDetails: "Context is missing required targetingKey property",
    });
  });

  it("maps an unknown Flag Key to 404 FLAG_NOT_FOUND", async () => {
    const { app } = await makeSdkRouteHarness();

    const response = await app.request(
      "/ofrep/v1/evaluate/flags/missing-flag",
      ofrepInit(CLIENT_KEY),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body).toEqual({
      key: "missing-flag",
      errorCode: "FLAG_NOT_FOUND",
      errorDetails: "Flag 'missing-flag' was not found",
    });
  });

  it("maps DEFAULT to STATIC and DISABLED to DISABLED", async () => {
    const noMatch = await makeSdkRouteHarness({
      flagOverrides: { targetingRules: [], rollout: null, experimentId: null },
    });
    const disabled = await makeSdkRouteHarness({ flagOverrides: { enabled: false } });

    const defaultBody = await (await noMatch.app.request(SINGLE, ofrepInit(CLIENT_KEY))).json();
    const disabledBody = await (await disabled.app.request(SINGLE, ofrepInit(CLIENT_KEY))).json();

    expect(defaultBody).toMatchObject({ key: FLAG_KEY, reason: "STATIC" });
    expect(disabledBody).toMatchObject({ key: FLAG_KEY, reason: "DISABLED" });
  });

  it("returns bulk flags as OFREP success or failure items", async () => {
    const { app, configKv } = await makeSdkRouteHarness();
    configKv.put(
      flagConfigKey(APP_ID, ENVIRONMENT_ID, "second-flag"),
      flagConfigKV({
        id: "flag-id-2",
        key: "second-flag",
        experimentId: null,
        targetingRules: [],
        rollout: null,
      }),
    );

    const response = await app.request(BULK, ofrepInit(CLIENT_KEY));
    const body = (await response.json()) as { flags: { key: string; reason?: string }[] };

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
    expect(body.flags.map((flag) => flag.key).sort()).toEqual(["checkout-banner", "second-flag"]);
    expect(body.flags.every((flag) => "reason" in flag || "errorCode" in flag)).toBe(true);
  });

  it("returns 304 with an empty body when If-None-Match matches", async () => {
    const { app } = await makeSdkRouteHarness();
    const first = await app.request(BULK, ofrepInit(CLIENT_KEY));
    const etag = first.headers.get("etag");
    const again = await app.request(BULK, ofrepInit(CLIENT_KEY, { "if-none-match": etag ?? "" }));

    expect(first.status).toBe(200);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });
});

describe("OFREP request validation maps to protocol errors", () => {
  it("maps missing context, null context, and non-object JSON to OFREP errors", async () => {
    const { app } = await makeSdkRouteHarness();
    const headers = {
      authorization: `Bearer ${CLIENT_KEY}`,
      "content-type": "application/json",
    };

    const missing = await app.request(SINGLE, {
      method: "POST",
      headers,
      body: "{}",
    });
    const nullContext = await app.request(SINGLE, {
      method: "POST",
      headers,
      body: JSON.stringify({ context: null }),
    });
    const nonObject = await app.request(SINGLE, {
      method: "POST",
      headers,
      body: "[]",
    });
    const malformed = await app.request(SINGLE, {
      method: "POST",
      headers,
      body: "{",
    });
    const bulkMissing = await app.request(BULK, {
      method: "POST",
      headers,
      body: "{}",
    });

    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      key: FLAG_KEY,
      errorCode: "INVALID_CONTEXT",
      errorDetails: "context is required and must be an object",
    });
    expect(nullContext.status).toBe(400);
    expect(await nullContext.json()).toMatchObject({
      key: FLAG_KEY,
      errorCode: "INVALID_CONTEXT",
    });
    expect(nonObject.status).toBe(400);
    expect(await nonObject.json()).toEqual({
      key: FLAG_KEY,
      errorCode: "PARSE_ERROR",
      errorDetails: "OFREP request body must be a JSON object",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      key: FLAG_KEY,
      errorCode: "PARSE_ERROR",
      errorDetails: "OFREP request body must be a JSON object",
    });
    expect(bulkMissing.status).toBe(400);
    expect(await bulkMissing.json()).toEqual({
      errorCode: "INVALID_CONTEXT",
      errorDetails: "context is required and must be an object",
    });
  });
});
