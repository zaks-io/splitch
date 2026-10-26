import { personalAccessTokenAuthority } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RouteHandler } from "@splitch/worker-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "./app";
import {
  ALPHA,
  args,
  principalFor,
  seedTwoTenants,
  USER_ADMIN,
  USER_MEMBER,
} from "./app-settings-fixture";
import { makeIntegrationDeliveryHandler } from "./integration-delivery-handler";
import { seedEnvironment } from "./test-seeds";

const NOW = Date.parse("2026-10-25T12:00:00Z");
let local: Awaited<ReturnType<typeof seedTwoTenants>>;
let repo: ReturnType<typeof createRepository>;
const wake = vi.fn().mockResolvedValue(undefined);
const getByName = vi.fn(() => ({ wake }));
const access = (mode = "coordinator") => ({
  INTEGRATION_DELIVERY_MODE: mode,
  INTEGRATION_DELIVERY: { getByName },
});

beforeEach(async () => {
  vi.clearAllMocks();
  local = await seedTwoTenants();
  for (const environmentId of ["env_one", "env_two"])
    await seedEnvironment(local.d1, { appId: ALPHA.appId, environmentId, key: environmentId });
  repo = createRepository(local.d1);
});
afterEach(async () => local.dispose());

function input(userId = USER_ADMIN, environmentId = "env_one") {
  return args(userId, ALPHA.appId, { params: { environmentId } }) as Parameters<
    RouteHandler<{ params: { appId: string; environmentId: string } }>
  >[0];
}

it("wakes only the requested Environment and returns scoped pending, leased and age counts", async () => {
  await seedDelivery("env_one", "one", "pending", "2026-10-25 11:58:00");
  await seedDelivery("env_one", "leased", "leased", "2026-10-25T11:59:00.000Z");
  await seedDelivery("env_one", "terminal", "terminal", "2026-10-25T10:00:00.000Z");
  await seedDelivery("env_two", "two", "pending", "2026-10-25T10:00:00.000Z");
  const handler = makeIntegrationDeliveryHandler({ repo, delivery: access(), nowMs: () => NOW });
  const response = await handler(input());
  expect(getByName).toHaveBeenCalledExactlyOnceWith(`${ALPHA.appId}:env_one`);
  expect(wake).toHaveBeenCalledExactlyOnceWith(ALPHA.appId, "env_one");
  expect(await response.json()).toEqual({
    appId: ALPHA.appId,
    environmentId: "env_one",
    wake: "scheduled",
    providers: {
      convex: { pendingCount: 1, leasedCount: 1, oldestOutstandingAgeMs: 120_000 },
      cloudflare: { pendingCount: 0, leasedCount: 0, oldestOutstandingAgeMs: null },
    },
  });
  await handler(input(USER_ADMIN, "env_two"));
  expect(wake).toHaveBeenLastCalledWith(ALPHA.appId, "env_two");
});

it("returns the summary with an explicit cron no-op and never wakes", async () => {
  const response = await makeIntegrationDeliveryHandler({ repo, delivery: access("cron") })(
    input(),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ wake: "cron_noop" });
  expect(getByName).not.toHaveBeenCalled();
});

it("denies members and removed membership despite admin token scopes", async () => {
  const handler = makeIntegrationDeliveryHandler({ repo, delivery: access() });
  expect((await handler(input(USER_MEMBER))).status).toBe(403);
  await local.d1.prepare("DELETE FROM app_memberships WHERE user_id = ?").bind(USER_ADMIN).run();
  expect((await handler(input())).status).toBe(403);
  expect(getByName).not.toHaveBeenCalled();
});

it("does not wake an Environment outside the App", async () => {
  const response = await makeIntegrationDeliveryHandler({ repo, delivery: access() })(
    input(USER_ADMIN, "env_missing"),
  );
  expect(response.status).toBe(404);
  expect(getByName).not.toHaveBeenCalled();
});

it("fails loudly when the coordinator rejects the wake", async () => {
  const error = new Error("unavailable");
  wake.mockRejectedValueOnce(error);
  const onFault = vi.fn();
  const request = input();
  const response = await makeIntegrationDeliveryHandler({ repo, delivery: access(), onFault })(
    request,
  );
  expect(onFault).toHaveBeenCalledExactlyOnceWith("integration_delivery_wake_failed", {
    appId: ALPHA.appId,
    environmentId: "env_one",
    requestId: request.requestId,
    fault: expect.stringContaining("Aggregate member: Error: [message withheld]"),
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("x-request-id")).toBe(request.requestId);
  expect(response.headers.get("retry-after")).toBe("30");
  expect(await response.json()).toMatchObject({
    code: "SERVICE_UNAVAILABLE",
    message: "Integration delivery coordinator is unavailable",
    details: { retryAfterMs: 30_000 },
  });
});

it("mounts the public API operation through the registrar", async () => {
  const onIntegrationDeliveryFault = vi.fn();
  const app = createApp({
    repo,
    integrationDelivery: access(),
    onIntegrationDeliveryFault,
    authResolver: async () => ({
      ok: true as const,
      principal: principalFor(USER_ADMIN, ALPHA.appId),
    }),
    rateLimiter: () => ({ limited: false }),
  });
  const response = await app.request(`/apps/${ALPHA.appId}/envs/env_one/integrations/deliveries`, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(wake).toHaveBeenCalledWith(ALPHA.appId, "env_one");
  wake.mockRejectedValueOnce(new Error("unavailable"));
  const unavailable = await app.request(
    `/apps/${ALPHA.appId}/envs/env_one/integrations/deliveries`,
    { method: "POST" },
  );
  expect(unavailable.status).toBe(503);
  expect(onIntegrationDeliveryFault).toHaveBeenCalledExactlyOnceWith(
    "integration_delivery_wake_failed",
    expect.objectContaining({
      appId: ALPHA.appId,
      environmentId: "env_one",
      requestId: expect.any(String),
      fault: expect.stringContaining("AggregateError"),
    }),
  );
});

it.each([false, true])(
  "requires the credentials grant even for an App admin, granted=%s",
  async (granted) => {
    const authority = personalAccessTokenAuthority(
      {
        organizations: [],
        apps: [{ id: ALPHA.appId, organizationId: ALPHA.orgId, role: "admin" }],
      },
      [
        {
          target: `app:${ALPHA.appId}`,
          role: "admin",
          permissions: granted ? ["credentials"] : [],
        },
      ],
    );
    const app = createApp({
      repo,
      integrationDelivery: access(),
      rateLimiter: () => ({ limited: false }),
      authResolver: () => ({
        ok: true,
        principal: {
          ...principalFor(USER_ADMIN, ALPHA.appId),
          scopes: authority.scopes,
          authDoor: "personal_access_token",
          personalAccessToken: { id: "pat_test", permissions: authority.permissions },
        },
      }),
    });
    const response = await app.request(
      `/apps/${ALPHA.appId}/envs/env_one/integrations/deliveries`,
      { method: "POST" },
    );
    expect(response.status).toBe(granted ? 200 : 403);
    if (!granted) expect(getByName).not.toHaveBeenCalled();
  },
);

async function seedDelivery(environmentId: string, id: string, state: string, createdAt: string) {
  await local.d1
    .prepare(`INSERT INTO convex_installations
    (installation_id, app_id, environment_id, callback_url, secret_ciphertext, secret_key_version,
     secret_fingerprint, status, created_at, updated_at)
    VALUES (?, ?, ?, 'https://example.convex.site/configuration', 'cipher', 'v1', 'hash', 'active', ?, ?)`)
    .bind(id, ALPHA.appId, environmentId, createdAt, createdAt)
    .run();
  await local.d1
    .prepare(`INSERT INTO config_webhook_deliveries
    (delivery_id, installation_id, app_id, environment_id, environment_version, state, body_json,
     next_attempt_at, created_at, lease_owner, lease_expires_at)
    VALUES (?, ?, ?, ?, 1, ?, '{}', ?, ?, ?, ?)`)
    .bind(
      id,
      id,
      ALPHA.appId,
      environmentId,
      state,
      createdAt,
      createdAt,
      state === "leased" ? "worker" : null,
      state === "leased" ? "2026-10-25T12:01:00Z" : null,
    )
    .run();
}
