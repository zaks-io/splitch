import { createRepository, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALPHA, seedTwoTenants } from "./app-settings-fixture";
import { makeCloudflareHandlers } from "./cloudflare-handlers";
import { seedEnvironment } from "./test-seeds";

const ENVIRONMENT_ID = "env_alpha_cloudflare";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-01T19:02:00.000Z";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

let dispose: () => Promise<void>;
let d1: D1Database;
let repo: ReturnType<typeof createRepository>;
let handlers: ReturnType<typeof makeCloudflareHandlers>;

beforeEach(async () => {
  const local = await seedTwoTenants();
  dispose = local.dispose;
  d1 = local.d1;
  await seedEnvironment(d1, { appId: ALPHA.appId, environmentId: ENVIRONMENT_ID, key: "prod" });
  repo = createRepository(d1);
  handlers = makeCloudflareHandlers({
    repo,
    secretKek: KEY,
    secretKeyVersion: "v1",
    now: () => new Date(NOW),
  });
});

afterEach(async () => dispose());

function register() {
  return handlers.create({
    input: {
      body: {
        installationId: INSTALLATION_ID,
        endpoint:
          "https://splitch-config-dev.customer.workers.dev/integrations/splitch/configuration",
        pushSecret: "p".repeat(43),
      },
    },
    principal: {
      kind: "api-key",
      id: "key_1",
      scopes: [],
      orgId: null,
      appId: ALPHA.appId,
      environmentId: ENVIRONMENT_ID,
      authDoor: null,
    },
    requestId: "req_test",
    request: new Request("https://control-plane.test/api/integrations/cloudflare/installations"),
  } as HandlerArgs<Parameters<typeof handlers.create>[0]["input"]>);
}

describe("Cloudflare installation registration", () => {
  it("re-arms a terminal delivery for the current version when setup reruns", async () => {
    const scope = envScope(ALPHA.appId, ENVIRONMENT_ID);
    expect((await register()).status).toBe(200);
    await d1
      .prepare(
        `UPDATE cloudflare_config_deliveries SET state = 'terminal', attempt_count = 9,
         last_error_json = '{"kind":"http","code":"HTTP_STATUS","httpStatus":404}',
         lease_owner = 'old-owner', lease_expires_at = ?, delivered_at = ?
         WHERE installation_id = ?`,
      )
      .bind(NOW, NOW, INSTALLATION_ID)
      .run();
    const before = await currentDelivery();
    expect(before.completed_at).not.toBeNull();

    expect((await register()).status).toBe(200);

    await expect(
      repo.cloudflare.deliveryHealth(scope, INSTALLATION_ID, Date.parse(NOW)),
    ).resolves.toMatchObject({ pendingCount: 1, terminalCount: 0 });
    expect(await currentDelivery()).toMatchObject({
      delivery_id: before.delivery_id,
      state: "pending",
      attempt_count: 0,
      next_attempt_at: NOW,
      completed_at: null,
      last_error_json: null,
      delivered_at: null,
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it("recreates the current-version delivery when setup reruns after terminal retention", async () => {
    const scope = envScope(ALPHA.appId, ENVIRONMENT_ID);
    expect((await register()).status).toBe(200);
    const before = await currentDelivery();
    await d1
      .prepare(`UPDATE cloudflare_config_deliveries SET state = 'terminal'
      WHERE delivery_id = ?`)
      .bind(before.delivery_id)
      .run();
    await d1
      .prepare(`UPDATE cloudflare_config_deliveries SET completed_at = ?
      WHERE delivery_id = ?`)
      .bind("2026-08-01T00:00:00.000Z", before.delivery_id)
      .run();
    expect(
      await repo.cloudflare.pruneDeliveries({
        completedBefore: "2026-09-01T00:00:00.000Z",
        limit: 100,
      }),
    ).toBe(1);
    expect(
      await repo.cloudflare.deliveryHealth(scope, INSTALLATION_ID, Date.parse(NOW)),
    ).toMatchObject({ pendingCount: 0, terminalCount: 0 });

    expect((await register()).status).toBe(200);

    const restored = await currentDelivery();
    expect(restored.delivery_id).not.toBe(before.delivery_id);
    expect(restored).toMatchObject({
      environment_version: before.environment_version,
      state: "pending",
      attempt_count: 0,
      next_attempt_at: NOW,
      completed_at: null,
      last_error_json: null,
    });
    const claimed = await repo.cloudflare.claimDueDeliveries(NOW, "recovered-owner", NOW, 25);
    expect(claimed).toEqual([expect.objectContaining({ deliveryId: restored.delivery_id })]);
    expect((await register()).status).toBe(200);
    expect(await currentDelivery()).toMatchObject({
      delivery_id: restored.delivery_id,
      state: "leased",
      lease_owner: "recovered-owner",
    });
  });
});

async function currentDelivery() {
  const rows = await d1
    .prepare(`SELECT * FROM cloudflare_config_deliveries
    WHERE installation_id = ?`)
    .bind(INSTALLATION_ID)
    .all<{
      delivery_id: string;
      environment_version: number;
      completed_at: string | null;
    }>();
  expect(rows.results).toHaveLength(1);
  const row = rows.results[0];
  if (!row) throw new Error("Missing current-version delivery");
  return row;
}
