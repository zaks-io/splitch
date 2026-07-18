import { env } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver.js";
import { durableConfigStoreAccess } from "../src/config-store-do.js";
import { ids, NOW_MS, seedConfigGraph } from "../src/config-store-fixture-data.js";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer.js";
import { makeJwksVerifier } from "../src/jwks-verify.js";
import { appAdminScope } from "../src/scope-binding.js";
import { makeSessionStore } from "../src/session-store.js";

const AUDIENCE = "https://cp.splitch.test";
const USER_ID = "user_live_updates";

let signer: FixtureSigner;

beforeAll(async () => {
  await seedConfigGraph(env.DB);
  signer = await makeFixtureSigner();
});

describe("live-update Durable Object", () => {
  it("broadcasts exactly one durable config nudge after a committed write", async () => {
    const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}`);
    const socketResponse = await stub.fetch("https://live.test/connect", {
      headers: { upgrade: "websocket" },
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

  it("rejects a WebSocket scoped to App A before it can attach to DO(B)", async () => {
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          fetchJwks: async () => signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(env.SESSION_STORE),
        now: () => NOW_MS,
      }),
      rateLimiter: () => ({ limited: false }),
      repo: createRepository(env.DB),
      configStore: durableConfigStoreAccess(env.CONFIG_STORE_WRITER),
    });
    const jwt = await token([appAdminScope(ids.appId)]);

    const response = await app.request(`/apps/${ids.otherAppId}/envs/${ids.environmentId}/live`, {
      headers: { authorization: `Bearer ${jwt}`, upgrade: "websocket" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(response.webSocket).toBeNull();
  });
});

async function token(scopes: string[]): Promise<string> {
  return signer.sign({
    sub: USER_ID,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + 3600,
    scopes,
  });
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
