import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { TinybirdDeleteError, type ExposureStatusDeleteScope } from "./tinybird-delete";

const APP_PATH = "/internal/apps/app_1/exposure-status";
const allowLimiter: RateLimiter = () => ({ limited: false });

describe("Environment Exposure status cleanup", () => {
  it("idempotently deletes either one Environment scope or the whole App scope", async () => {
    const deleted: ExposureStatusDeleteScope[] = [];
    const app = cleanupApp(principal(null), deleted);
    const appResponse = await app.request(APP_PATH, { method: "DELETE" });

    expect(appResponse.status).toBe(200);
    expect(await appResponse.json()).toEqual({ deleted: true });
    expect(deleted).toEqual([{ appId: "app_1" }]);

    const retryResponse = await app.request(APP_PATH, { method: "DELETE" });
    expect(retryResponse.status).toBe(200);
    expect(deleted).toEqual([{ appId: "app_1" }, { appId: "app_1" }]);

    const environmentApp = cleanupApp(principal("env_prod"), deleted);
    const environmentResponse = await environmentApp.request(`${APP_PATH}?environmentId=env_prod`, {
      method: "DELETE",
    });

    expect(environmentResponse.status).toBe(200);
    expect(deleted).toEqual([
      { appId: "app_1" },
      { appId: "app_1" },
      { appId: "app_1", environmentId: "env_prod" },
    ]);
  });

  it("fails before Tinybird when delegated App or Environment scope differs", async () => {
    const deleted: ExposureStatusDeleteScope[] = [];
    const response = await cleanupApp(principal("env_other"), deleted).request(
      `${APP_PATH}?environmentId=env_prod`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(403);
    expect(deleted).toEqual([]);
  });

  it("maps Tinybird cleanup failure to retryable SERVICE_UNAVAILABLE", async () => {
    const authResolver: AuthResolver = () => ({ ok: true, principal: principal(null) });
    const app = createApp({
      door: "binding",
      authResolver,
      rateLimiter: allowLimiter,
      tinybird: { readPipe: async () => [] },
      tinybirdDelete: {
        deleteExposureStatus: async () => {
          throw new TinybirdDeleteError("forced outage");
        },
      },
    });

    const response = await app.request(APP_PATH, { method: "DELETE" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      details: { retryAfterMs: 30_000 },
    });
  });
});

function cleanupApp(scope: Principal, deleted: ExposureStatusDeleteScope[]) {
  const authResolver: AuthResolver = () => ({ ok: true, principal: scope });
  return createApp({
    door: "binding",
    authResolver,
    rateLimiter: allowLimiter,
    tinybird: { readPipe: async () => [] },
    tinybirdDelete: {
      deleteExposureStatus: async (input) => {
        deleted.push(input);
      },
    },
  });
}

function principal(environmentId: string | null): Principal {
  return {
    kind: "control-plane-token",
    id: "control-plane-api",
    scopes: [],
    orgId: "org_1",
    appId: "app_1",
    environmentId,
    authDoor: null,
  };
}
