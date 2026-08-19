import { EnvironmentExposureStatusResponseSchema, type ErrorResponse } from "@splitch/contracts";
import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeExposureStatusHandler, readExposureStatusFromTinybird } from "./exposure-status";
import { type PipeParams, TinybirdReadError, type TinybirdReadTransport } from "./tinybird";

const APP_ID = "app_checkout";
const ENVIRONMENT_ID = "env_dev";
const STATUS_PATH = `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/exposure-status`;

class FakeTinybird implements TinybirdReadTransport {
  readonly calls: { pipeName: string; params: PipeParams }[] = [];

  constructor(private readonly rows: readonly unknown[]) {}

  async readPipe(pipeName: string, params: PipeParams): Promise<readonly unknown[]> {
    this.calls.push({ pipeName, params: { ...params } });
    return this.rows;
  }
}

const allowLimiter: RateLimiter = () => ({ limited: false });

function principal(appId: string | null, environmentId: string | null): Principal {
  return {
    kind: "control-plane-token",
    id: "user_1",
    scopes: [],
    orgId: "org_1",
    appId,
    environmentId,
    authDoor: null,
  };
}

function appWith(tinybird: TinybirdReadTransport, scope = principal(APP_ID, ENVIRONMENT_ID)) {
  const authResolver: AuthResolver = () => ({ ok: true, principal: scope });
  return createApp({
    door: "binding",
    authResolver,
    rateLimiter: allowLimiter,
    tinybird,
    tinybirdDelete: { deleteExposureStatus: async () => {} },
  });
}

describe("Environment Exposure status", () => {
  it("returns received with the earliest durable timestamp and both Tinybird tenant parameters", async () => {
    const tinybird = new FakeTinybird([
      {
        app_id: APP_ID,
        environment_id: ENVIRONMENT_ID,
        first_exposure_at: "2026-08-18 12:34:56.789",
      },
    ]);

    const response = await appWith(tinybird).request(STATUS_PATH);

    expect(response.status).toBe(200);
    expect(EnvironmentExposureStatusResponseSchema.parse(await response.json())).toEqual({
      state: "received",
      firstExposureAt: "2026-08-18T12:34:56.789Z",
    });
    expect(tinybird.calls).toEqual([
      {
        pipeName: "environment_exposure_status",
        params: { app_id: APP_ID, environment_id: ENVIRONMENT_ID },
      },
    ]);
  });

  it("returns not_received only for a successful empty scoped read", async () => {
    const response = await appWith(new FakeTinybird([])).request(STATUS_PATH);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "not_received", firstExposureAt: null });
  });

  it("maps a Tinybird outage to a retryable service-unavailable envelope", async () => {
    const tinybird: TinybirdReadTransport = {
      readPipe: async () => {
        throw new TinybirdReadError("forced outage");
      },
    };

    const response = await appWith(tinybird).request(STATUS_PATH);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      details: { retryAfterMs: 30_000 },
    });
  });

  it("never turns malformed analytics rows into not_received", async () => {
    for (const rows of [
      [{ app_id: APP_ID, environment_id: ENVIRONMENT_ID }],
      [
        {
          app_id: APP_ID,
          environment_id: ENVIRONMENT_ID,
          first_exposure_at: "not-a-timestamp",
        },
      ],
      [
        {
          app_id: APP_ID,
          environment_id: ENVIRONMENT_ID,
          first_exposure_at: "2026-08-18 12:34:56.789",
        },
        {
          app_id: APP_ID,
          environment_id: ENVIRONMENT_ID,
          first_exposure_at: "2026-08-19 12:34:56.789",
        },
      ],
    ]) {
      const response = await appWith(new FakeTinybird(rows)).request(STATUS_PATH);
      expect(response.status).toBe(500);
      expect((await response.json()) as ErrorResponse).toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
    }
  });
});

describe("Environment Exposure status isolation", () => {
  it("fails closed when an Environment-unbound delegated principal reaches another Environment scope", async () => {
    const tinybird = new FakeTinybird([]);
    const response = await appWith(tinybird, principal("app_checkout_unbound", null)).request(
      "/apps/app_checkout_unbound/envs/env_checkout_target/exposure-status",
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: "credential is not scoped to this Environment",
    });
    expect(tinybird.calls).toEqual([]);
  });

  it("fails closed when the delegated principal carries a different App scope", async () => {
    const tinybird = new FakeTinybird([]);
    const handler = makeExposureStatusHandler({ tinybird });
    const response = await handler({
      input: {
        params: {
          appId: "app_checkout_requested",
          environmentId: "env_checkout_requested",
        },
      },
      principal: principal("app_billing_principal", "env_billing_principal"),
      requestId: "req_cross_app_scope",
      request: new Request(
        "https://analysis.internal/apps/app_checkout_requested/envs/env_checkout_requested/exposure-status",
      ),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: "credential is not scoped to this Environment",
    });
    expect(tinybird.calls).toEqual([]);
  });

  it("fails closed if Tinybird returns a row outside either requested tenant axis", async () => {
    for (const row of [
      {
        app_id: "app_other",
        environment_id: ENVIRONMENT_ID,
        first_exposure_at: "2026-08-18 12:34:56.789",
      },
      {
        app_id: APP_ID,
        environment_id: "env_other",
        first_exposure_at: "2026-08-18 12:34:56.789",
      },
    ]) {
      await expect(
        readExposureStatusFromTinybird(new FakeTinybird([row]), {
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
        }),
      ).rejects.toThrow("outside the requested App and Environment scope");
    }
  });
});
