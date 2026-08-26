import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { DurableConfigUpdates } from "../../evaluation-api/src/provider/config-updates.js";
import { FakeKv } from "../../evaluation-api/src/provider/fake-kv.js";
import { flagConfigKV } from "../../evaluation-api/src/provider/fixtures.js";
import { KvProvider } from "../../evaluation-api/src/provider/kv-provider.js";
import { LIVE_UPDATE_CONTEXT_HEADER } from "../src/config-store-do.js";
import { ids, seedConfigGraph } from "../src/config-store-fixture-data.js";

const USER_ID = "user_live_updates";
const DEFAULT_SESSION_VALIDITY_MS = 3_600_000;

beforeAll(async () => {
  await seedConfigGraph(env.DB);
});

describe("live-update Durable Object broadcast", () => {
  it("broadcasts exactly one durable config nudge after a committed write", async () => {
    const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}`);
    const context = await seededLiveUpdateContext();
    const socketResponse = await stub.fetch("https://live.test/connect", {
      headers: { upgrade: "websocket", [LIVE_UPDATE_CONTEXT_HEADER]: JSON.stringify(context) },
    });
    expect(socketResponse.status).toBe(101);

    const socket = socketResponse.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();

    const messages: unknown[] = [];
    socket?.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)));
    });

    const result = await stub.writeFlagConfig({
      actor: { ref: USER_ID, via: "id_jag" },
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      enabled: true,
      availableVariantNames: ["control"],
    });

    expect(result).toMatchObject({
      ok: true,
      config: { flagId: ids.flagId, version: 2, enabled: true },
      nudge: { type: "config.changed", entity: "flag", id: ids.flagId, version: 2 },
    });
    await waitForMessages(messages, 1);
    await delay(25);

    expect(messages).toEqual([
      { type: "config.changed", entity: "flag", id: ids.flagId, version: 2 },
    ]);

    socket?.close(1000, "test done");
  });
});

describe("Evaluation Worker live-update subscription", () => {
  it("invalidates its cache and bypasses a stale KV POP", async () => {
    const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}`);
    await stub.writeFlagConfig({
      actor: { ref: USER_ID, via: "id_jag" },
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      enabled: false,
      availableVariantNames: ["control"],
    });
    const staleKv = new FakeKv().put(
      `app:${ids.appId}:${ids.environmentId}:flag:${ids.flagKey}`,
      flagConfigKV({
        id: ids.flagId,
        key: ids.flagKey,
        environmentId: ids.environmentId,
        enabled: false,
      }),
    );
    const provider = new KvProvider(staleKv, {
      configUpdates: new DurableConfigUpdates(env.CONFIG_STORE_WRITER),
    });
    await expect(
      provider.getFlag(ids.appId, ids.environmentId, ids.flagKey),
    ).resolves.toMatchObject({
      enabled: false,
    });

    await stub.writeFlagConfig({
      actor: { ref: USER_ID, via: "id_jag" },
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      enabled: true,
      availableVariantNames: ["control"],
    });
    await delay(25);

    await expect(
      provider.getFlag(ids.appId, ids.environmentId, ids.flagKey),
    ).resolves.toMatchObject({
      enabled: true,
    });
    expect(staleKv.getCalls).toHaveLength(0);

    await stub.setLiveUpdatesAvailable(false);
    await delay(25);
    await stub.setLiveUpdatesAvailable(true);
    await expect(
      provider.getFlag(ids.appId, ids.environmentId, ids.flagKey),
    ).resolves.toMatchObject({
      enabled: true,
    });
    expect(staleKv.getCalls).toHaveLength(0);
  });
});

async function seededLiveUpdateContext() {
  const sessionTokenHash = "a".repeat(64);
  const expiresAt = Math.ceil((Date.now() + DEFAULT_SESSION_VALIDITY_MS) / 1_000);
  await env.SESSION_STORE.put(
    `session:${sessionTokenHash}`,
    JSON.stringify({
      userId: USER_ID,
      expiresAt,
      version: 2,
      orgs: [
        {
          orgId: ids.orgId,
          orgSlug: "config-org",
          orgRole: "admin",
          isProvisional: false,
          demoExpiresAt: null,
          apps: [{ appId: ids.appId, appSlug: "config-app", role: "admin" }],
        },
      ],
    }),
  );
  return {
    version: 1 as const,
    sessionTokenHash,
    userId: USER_ID,
    orgId: ids.orgId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    expiresAt,
  };
}

async function waitForMessages(messages: unknown[], count: number): Promise<void> {
  for (let i = 0; i < 20 && messages.length < count; i++) {
    await delay(5);
  }
  expect(messages).toHaveLength(count);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
