import { env } from "cloudflare:workers";
import type { ControlPanelOperation } from "@splitch/control-plane-sdk/control-panel-identity";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import worker, { type SignedControlPanelEntrypoint } from "../src/index.js";
import {
  panelEntrypoint,
  panelFlagsIds,
  panelTestEnv,
  seedAppMembership,
  seedPanelFlags,
  signedPanelRequest,
  testCtx,
} from "./panel-flags-harness.js";

const ids = panelFlagsIds("e2e");
const { appId: APP_ID, otherAppId: OTHER_APP_ID, envId: ENV_ID } = ids;
const { otherEnvId: OTHER_ENV_ID, flagId: FLAG_ID, userId: USER_ID } = ids;

let testEnv: ControlPlaneApiEnv;
let entrypoint: SignedControlPanelEntrypoint;

beforeAll(async () => {
  await seedPanelFlags(ids);
  testEnv = panelTestEnv();
  entrypoint = panelEntrypoint(testEnv);
});

afterAll(() => vi.unstubAllGlobals());

describe("SignedControlPanelEntrypoint Flags operations", () => {
  it("lists definitions and this Environment's Configuration", async () => {
    const list = await panelRequest("GET", `/apps/${APP_ID}/flags`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      items: Array<{ id: string; key: string; variants: Array<{ name: string }> }>;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: FLAG_ID, key: "checkout-refresh" });
    expect(listed.items[0]?.variants.map((variant) => variant.name)).toEqual([
      "disabled",
      "enabled",
    ]);

    const config = await panelRequest(
      "GET",
      `/apps/${APP_ID}/envs/${ENV_ID}/flags/${FLAG_ID}/config`,
    );
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({
      flagId: FLAG_ID,
      environmentId: ENV_ID,
      enabled: true,
      availableVariantNames: ["disabled", "enabled"],
    });
  });

  it("creates the guided boolean catalog through the authoritative Worker handler", async () => {
    const response = await panelRequest("POST", `/apps/${APP_ID}/flags`, {
      appId: APP_ID,
      idempotency_key: "idem-panel-create-flag",
      key: "new-checkout",
      name: "New Checkout",
      schema: { type: "boolean" },
      variants: [
        { name: "disabled", value: false, isDefault: true },
        { name: "enabled", value: true, isDefault: false },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      appId: APP_ID,
      key: "new-checkout",
      variants: [{ name: "disabled" }, { name: "enabled" }],
    });
  });

  it("rechecks live App membership and Environment ownership", async () => {
    await env.DB.prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(APP_ID, USER_ID)
      .run();
    const removed = await panelRequest("GET", `/apps/${APP_ID}/flags`);
    expect(removed.status).toBe(403);
    expect(await removed.json()).toMatchObject({ code: "FORBIDDEN" });
    await seedAppMembership(ids);

    const crossApp = await panelRequest(
      "GET",
      `/apps/${APP_ID}/envs/${OTHER_ENV_ID}/flags/${FLAG_ID}/config`,
    );
    expect(crossApp.status).toBe(403);
    expect(await crossApp.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps the public Worker and unsupported binding methods closed", async () => {
    const publicResponse = await publicRequest("GET", `/apps/${APP_ID}/flags`);
    expect(publicResponse.status).toBe(401);
    expect(await publicResponse.json()).toMatchObject({ code: "UNAUTHORIZED" });

    const unsupported = await panelRequest("PATCH", `/apps/${APP_ID}/flags/${FLAG_ID}`, {
      name: "Not allowed",
    });
    expect(unsupported.status).toBe(404);
  });

  it("binds operation, App, Environment, actor, expiry, and replay", async () => {
    const replayedRequest = await request("GET", `/apps/${APP_ID}/flags`);
    const replayResponses = await Promise.all([
      entrypoint.fetch(replayedRequest.clone()),
      entrypoint.fetch(replayedRequest.clone()),
    ]);
    expect(replayResponses.map((response) => response.status).sort()).toEqual([200, 401]);

    const wrongOperation = await request("GET", `/apps/${APP_ID}/flags`, undefined, {
      id: "flags_create",
      appId: APP_ID,
      environmentId: ENV_ID,
    });
    expect((await entrypoint.fetch(wrongOperation)).status).toBe(401);

    const wrongApp = await request("GET", `/apps/${APP_ID}/flags`, undefined, {
      id: "flags_list",
      appId: OTHER_APP_ID,
      environmentId: ENV_ID,
    });
    expect((await entrypoint.fetch(wrongApp)).status).toBe(401);

    const wrongEnvironment = await request("GET", `/apps/${APP_ID}/flags`, undefined, {
      id: "flags_list",
      appId: APP_ID,
      environmentId: OTHER_ENV_ID,
    });
    expect((await entrypoint.fetch(wrongEnvironment)).status).toBe(401);

    const wrongActor = await request(
      "GET",
      `/apps/${APP_ID}/flags`,
      undefined,
      undefined,
      "user_other",
    );
    expect((await entrypoint.fetch(wrongActor)).status).toBe(403);

    const expired = await request(
      "GET",
      `/apps/${APP_ID}/flags`,
      undefined,
      undefined,
      USER_ID,
      -1,
    );
    expect((await entrypoint.fetch(expired)).status).toBe(401);
  });

  it("does not redeem one delegation for a different request body", async () => {
    const originalBody = {
      appId: APP_ID,
      idempotency_key: "idem-panel-body-bound",
      key: "body-bound-original",
      name: "Body Bound Original",
      schema: { type: "boolean" },
      variants: [
        { name: "disabled", value: false, isDefault: true },
        { name: "enabled", value: true, isDefault: false },
      ],
    };
    const changed = await request(
      "POST",
      `/apps/${APP_ID}/flags`,
      { ...originalBody, key: "body-bound-changed" },
      undefined,
      USER_ID,
      30,
      originalBody,
    );

    expect((await entrypoint.fetch(changed)).status).toBe(401);
  });
});

describe("SignedControlPanelEntrypoint Flag resource binding", () => {
  it("rejects a flag_config_get delegation for a different Flag", async () => {
    const wrongFlag = await request(
      "GET",
      `/apps/${APP_ID}/envs/${ENV_ID}/flags/${FLAG_ID}/config`,
      undefined,
      {
        id: "flag_config_get",
        appId: APP_ID,
        environmentId: ENV_ID,
        flagId: "flag_other",
      },
    );

    expect((await entrypoint.fetch(wrongFlag)).status).toBe(401);
  });
});

async function panelRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return entrypoint.fetch(await request(method, path, body));
}

async function publicRequest(method: string, path: string): Promise<Response> {
  return Promise.resolve(worker.fetch(await request(method, path), testEnv, testCtx));
}

function request(
  method: string,
  path: string,
  body?: unknown,
  delegatedOperation?: ControlPanelOperation,
  actorId = USER_ID,
  expiresInSeconds = 30,
  delegatedBody = body,
): Promise<Request> {
  return signedPanelRequest(
    ids,
    method,
    path,
    body,
    delegatedOperation,
    actorId,
    expiresInSeconds,
    delegatedBody,
  );
}
