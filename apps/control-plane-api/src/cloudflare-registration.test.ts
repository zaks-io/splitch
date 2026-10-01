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
        "UPDATE cloudflare_config_deliveries SET state = 'terminal' WHERE installation_id = ?",
      )
      .bind(INSTALLATION_ID)
      .run();

    expect((await register()).status).toBe(200);

    await expect(
      repo.cloudflare.deliveryHealth(scope, INSTALLATION_ID, Date.parse(NOW)),
    ).resolves.toMatchObject({ pendingCount: 1, terminalCount: 0 });
  });
});
