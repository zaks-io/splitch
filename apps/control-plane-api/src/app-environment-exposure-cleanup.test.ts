import { appScope, createRepository } from "@splitch/db";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import {
  EnvironmentExposureStatusCleanupError,
  type EnvironmentExposureStatusCleanupInput,
} from "./environment-exposure-status-cleanup";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";

const APP_ID = "app_cleanup";
const ORG_ID = "org_cleanup";
const ENV_DEV = "env_cleanup_dev";
const ENV_PROD = "env_cleanup_prod";

let bindings: LocalBindings;

beforeEach(async () => {
  bindings = await makeLocalBindings();
  await bindings.d1.batch([
    bindings.d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(ORG_ID, "Cleanup Org", "cleanup-org", "2026-08-18", "2026-08-18"),
    bindings.d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(APP_ID, ORG_ID, "Cleanup App", "cleanup-app", "2026-08-18", "2026-08-18"),
    bindings.d1
      .prepare(
        "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(APP_ID, "user_owner", "owner", "2026-08-18"),
    ...[ENV_DEV, ENV_PROD].map((environmentId, index) =>
      bindings.d1
        .prepare(
          "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          environmentId,
          APP_ID,
          index === 0 ? "dev" : "prod",
          index === 0 ? "Development" : "Production",
          "2026-08-18",
          "2026-08-18",
        ),
    ),
  ]);
});

afterEach(async () => bindings.dispose());

describe("App and Environment Exposure status cleanup", () => {
  it("purges the Environment scope after deleting an Environment", async () => {
    const calls: EnvironmentExposureStatusCleanupInput[] = [];
    const response = await app(calls).request(`/apps/${APP_ID}/envs/${ENV_DEV}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        appId: APP_ID,
        environmentId: ENV_DEV,
        actorId: "user_owner",
        orgId: ORG_ID,
        requestId: expect.any(String),
      },
    ]);
    expect(
      await createRepository(bindings.d1).identity.getEnvironment(appScope(APP_ID), ENV_DEV),
    ).toBeNull();
  });

  it("purges every Environment state row after the App cascade", async () => {
    const calls: EnvironmentExposureStatusCleanupInput[] = [];
    const response = await app(calls).request(`/apps/${APP_ID}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        appId: APP_ID,
        actorId: "user_owner",
        orgId: ORG_ID,
        requestId: expect.any(String),
      },
    ]);
    expect(await createRepository(bindings.d1).identity.getApp(APP_ID)).toBeNull();
  });

  it("does not purge status when a later Environment delete step fails", async () => {
    await bindings.d1
      .prepare(
        `CREATE TRIGGER fail_environment_delete
         BEFORE DELETE ON environments
         WHEN OLD.id = '${ENV_DEV}'
         BEGIN
           SELECT RAISE(FAIL, 'forced Environment delete failure');
         END`,
      )
      .run();
    const calls: EnvironmentExposureStatusCleanupInput[] = [];

    const response = await app(calls).request(`/apps/${APP_ID}/envs/${ENV_DEV}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(500);
    expect(calls).toEqual([]);
    expect(
      await createRepository(bindings.d1).identity.getEnvironment(appScope(APP_ID), ENV_DEV),
    ).not.toBeNull();
  });

  it("does not purge status when the App cascade fails", async () => {
    await bindings.d1
      .prepare(
        `CREATE TRIGGER fail_app_delete
         BEFORE DELETE ON apps
         WHEN OLD.id = '${APP_ID}'
         BEGIN
           SELECT RAISE(FAIL, 'forced App delete failure');
         END`,
      )
      .run();
    const calls: EnvironmentExposureStatusCleanupInput[] = [];

    const response = await app(calls).request(`/apps/${APP_ID}`, { method: "DELETE" });

    expect(response.status).toBe(500);
    expect(calls).toEqual([]);
    expect(await createRepository(bindings.d1).identity.getApp(APP_ID)).not.toBeNull();
  });

  it("returns a retryable failure when last-step cleanup is unavailable", async () => {
    const calls: EnvironmentExposureStatusCleanupInput[] = [];
    const response = await app(calls, async (input) => {
      calls.push(input);
      throw new EnvironmentExposureStatusCleanupError("forced cleanup outage");
    }).request(`/apps/${APP_ID}`, { method: "DELETE" });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(calls).toHaveLength(1);
    expect(await createRepository(bindings.d1).identity.getApp(APP_ID)).toBeNull();
  });
});

function app(
  calls: EnvironmentExposureStatusCleanupInput[],
  cleanup: (input: EnvironmentExposureStatusCleanupInput) => Promise<void> = async (input) => {
    calls.push(input);
  },
) {
  const authResolver: AuthResolver = () => ({
    ok: true,
    principal: {
      kind: "control-plane-token",
      id: "user_owner",
      scopes: [`app:${APP_ID}:owner`],
      orgId: ORG_ID,
      appId: APP_ID,
      environmentId: null,
      authDoor: "device_flow",
    },
  });
  const rateLimiter: RateLimiter = () => ({ limited: false });
  return createApp({
    authResolver,
    rateLimiter,
    repo: createRepository(bindings.d1),
    credentialStore: bindings.credentialKv,
    exposureStatusCleanup: {
      delete: cleanup,
    },
    holdoverWriteOutboxCleanup: {
      delete: async () => undefined,
    },
  });
}
