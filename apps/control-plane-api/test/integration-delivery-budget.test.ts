import { env } from "cloudflare:test";
import { createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchCloudflarePushes } from "../src/cloudflare-push-dispatch";
import { dispatchConvexWebhooks } from "../src/convex-webhook-dispatch";
import {
  coordinatorDeliveryPolicy,
  DELIVERY_RUN_SUBREQUEST_BUDGET,
} from "../src/integration-delivery-limits";
import { runIntegrationDelivery } from "../src/integration-delivery-run";
import { integrationDeliverySubrequests } from "../src/integration-delivery-subrequests";
import { appId, bump, environmentB, install, setupDelivery } from "./integration-delivery-fixture";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 3_600_000);
  await setupDelivery();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.for([true, false])(
  "bounds a 1,000-flag App's run with snapshot caching %s",
  async (cached, context) => {
    await seedFlags();
    await seedInstallations(3_001);
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM cloudflare_config_deliveries WHERE state = 'pending'",
    ).first<{ count: number }>();
    expect(pending?.count).toBeGreaterThan(3_000);
    const requests = integrationDeliverySubrequests(env.DB, async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.flags).toHaveLength(1_000);
      return new Response(null, {
        status: 200,
        headers: { "splitch-environment-version": String(body.environmentVersion) },
      });
    });
    const repository = createRepository(requests.db);
    const findFlags = vi.spyOn(repository.flags.flags, "findMany");
    const claimCounts: number[] = [];
    const claim = repository.cloudflare.claimDueDeliveries;
    vi.spyOn(repository.cloudflare, "claimDueDeliveries").mockImplementation((...args) => {
      claimCounts.push(requests.count);
      return claim(...args);
    });
    const snapshotCache = new Map();
    const result = await runIntegrationDelivery({
      repo: repository,
      scope: envScope(appId, environmentB),
      now: () => new Date(),
      subrequests: requests,
      dispatchConvex: (scope, onDispatch) =>
        dispatchConvexWebhooks({
          repo: repository,
          scope,
          onDispatch,
          fetcher: requests.fetcher,
          policy: coordinatorDeliveryPolicy(),
          webhookKek: env.CONVEX_WEBHOOK_KEK,
        }),
      dispatchCloudflare: (scope, onDispatch) =>
        dispatchCloudflarePushes({
          repo: repository,
          scope,
          onDispatch,
          fetcher: requests.fetcher,
          snapshotCache: cached ? snapshotCache : undefined,
          policy: coordinatorDeliveryPolicy(),
          secretKek: env.INTEGRATION_SECRET_KEK,
        }),
    });
    expect(requests.count).toBeGreaterThanOrEqual(DELIVERY_RUN_SUBREQUEST_BUDGET);
    expect(requests.count).toBeLessThan(5_100);
    expect(result.subrequests).toBe(requests.count);
    expect(result.nextWakeAt).toBe(new Date().toISOString());
    expect(result.summary.cloudflare.claimed).toBeLessThan(3_001);
    expect(result.summary.cloudflare.received2xx).toBe(requests.http);
    expect(claimCounts.every((count) => count < DELIVERY_RUN_SUBREQUEST_BUDGET)).toBe(true);
    if (cached) {
      expect(result.summary.cloudflare.claimed).toBeGreaterThan(1_000);
      expect(findFlags).toHaveBeenCalledTimes(1);
      expect(snapshotCache.size).toBe(1);
    } else {
      expect(result.summary.cloudflare.claimed).toBeLessThan(1_000);
      expect(findFlags.mock.calls.length).toBeGreaterThan(1);
    }
    context.task.meta.deliveryBudgetResult = {
      cached,
      d1: requests.d1,
      http: requests.http,
      total: requests.count,
      claimed: result.summary.cloudflare.claimed,
      snapshotBuilds: findFlags.mock.calls.length,
    };
  },
);

it("rebuilds cached snapshots when the Environment version changes", async () => {
  await install("cloudflare", "versioned", environmentB);
  const repository = createRepository(env.DB);
  const findFlags = vi.spyOn(repository.flags.flags, "findMany");
  const versions: number[] = [];
  const deps = {
    repo: repository,
    scope: envScope(appId, environmentB),
    snapshotCache: new Map(),
    policy: coordinatorDeliveryPolicy(),
    secretKek: env.INTEGRATION_SECRET_KEK,
    fetcher: (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      versions.push(body.environmentVersion);
      return new Response(null, {
        status: 200,
        headers: {
          "splitch-environment-version": String(body.environmentVersion),
        },
      });
    }) satisfies typeof fetch,
  };
  await dispatchCloudflarePushes(deps);
  await bump(environmentB);
  await dispatchCloudflarePushes(deps);
  expect(versions).toEqual([0, 1]);
  expect(findFlags).toHaveBeenCalledTimes(2);
});

async function seedFlags() {
  await env.DB.batch([
    env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
      INSERT INTO flags (id, app_id, key, name, lifecycle_class, created_at, updated_at)
      SELECT 'budget_flag_' || i, ?, 'flag_' || i, 'Flag ' || i, 'release',
        '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z' FROM n`).bind(appId),
    env.DB.prepare(`INSERT INTO variants (id, flag_id, name, value, created_at)
      SELECT 'variant_' || id, id, 'control', 'false', '2026-10-25T00:00:00.000Z'
      FROM flags WHERE app_id = ?`).bind(appId),
    env.DB.prepare(`INSERT INTO flag_configs
      (id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id,
       created_at, updated_at)
      SELECT 'config_' || id, app_id, ?, id, 1, '["control"]', 'variant_' || id,
        '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z'
      FROM flags WHERE app_id = ?`).bind(environmentB, appId),
  ]);
}

async function seedInstallations(count: number) {
  await install("cloudflare", "template", environmentB);
  await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO cloudflare_installations
      (installation_id, app_id, environment_id, endpoint, secret_ciphertext, secret_key_version,
       secret_fingerprint, status, created_at, updated_at)
    SELECT 'budget_' || i, app_id, environment_id, endpoint, secret_ciphertext, secret_key_version,
      secret_fingerprint, status, created_at, updated_at
    FROM cloudflare_installations, n WHERE installation_id = 'template'`)
    .bind(count - 1)
    .run();
  await bump(environmentB);
}
