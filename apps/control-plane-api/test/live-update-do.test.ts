import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { authorizeLiveUpdateUpgrade } from "../../control-panel/src/lib/live-update-authorization.js";
import { handleLiveUpdateUpgrade } from "../../control-panel/src/lib/live-update-upgrade.js";
import { createApp } from "../src/app.js";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver.js";
import { durableConfigStoreAccess } from "../src/config-store-access.js";
import { ids, NOW_MS, seedConfigGraph } from "../src/config-store-fixture-data.js";
import { LIVE_UPDATE_CONTEXT_HEADER } from "../src/config-store-live-update-context.js";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer.js";
import { makeJwksVerifier } from "../src/jwks-verify.js";
import { appAdminScope } from "../src/scope-binding.js";
import { makeSessionStore } from "../src/session-store.js";

const AUDIENCE = "https://cp.splitch.test";
const USER_ID = "user_live_updates";
const DEFAULT_SESSION_VALIDITY_MS = 3_600_000;

/**
 * How long the expiring panel session stays valid. It has to outlast the connect
 * handshake by enough that machine load cannot eat it, and stay well inside the
 * per-test timeout so the expiry alarm still gets to fire. Seeding measured at
 * 2-32ms, so this is a ~60x margin.
 */
const EXPIRING_SESSION_VALIDITY_MS = 2_000;

let signer: FixtureSigner;

beforeAll(async () => {
  await seedConfigGraph(env.DB);
  signer = await makeFixtureSigner();
});

describe("live-update Durable Object authorization", () => {
  it("rejects a socket without immutable server-authenticated connection metadata", async () => {
    const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}`);

    const response = await stub.fetch("https://live.test/connect", {
      headers: { upgrade: "websocket" },
    });

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it("closes a silent revoked panel session after hibernation", async () => {
    const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}:revoked`);
    const context = await seededLiveUpdateContext();
    const response = await stub.fetch("https://live.test/connect", {
      headers: { upgrade: "websocket", [LIVE_UPDATE_CONTEXT_HEADER]: JSON.stringify(context) },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const closed = waitForClose(socket as WebSocket);

    await evictDurableObject(stub);
    await env.SESSION_STORE.delete(`session:${context.sessionTokenHash}`);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await expect(closed).resolves.toMatchObject({ code: 1008 });
  });

  it("closes a silent expired panel session after hibernation", async () => {
    const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}:expired`);
    const context = await seededLiveUpdateContext({
      validForMs: EXPIRING_SESSION_VALIDITY_MS,
      sessionTokenHash: "b".repeat(64),
    });
    const response = await stub.fetch("https://live.test/connect", {
      headers: { upgrade: "websocket", [LIVE_UPDATE_CONTEXT_HEADER]: JSON.stringify(context) },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const closed = waitForClose(socket as WebSocket);

    await evictDurableObject(stub);
    await expect(closed).resolves.toMatchObject({ code: 1008 });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("rejects a WebSocket scoped to App A before it can attach to DO(B)", async () => {
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          fetchJwks: async () => signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(env.SESSION_STORE),
        membershipAccess: { authorize: async () => true },
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

  it("forwards a server-authenticated context after bearer scope validation", async () => {
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          fetchJwks: async () => signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(env.SESSION_STORE),
        membershipAccess: { authorize: async () => true },
        now: () => NOW_MS,
      }),
      rateLimiter: () => ({ limited: false }),
      repo: createRepository(env.DB),
      configStore: durableConfigStoreAccess(env.CONFIG_STORE_WRITER),
    });
    const jwt = await token([appAdminScope(ids.appId)]);

    const response = await app.request(`/apps/${ids.appId}/envs/${ids.environmentId}/live`, {
      headers: { authorization: `Bearer ${jwt}`, upgrade: "websocket" },
    });

    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, "test done");
  });

  it.each([
    { name: "invalid session", path: "/config-org/config-app/production/live", seed: false },
    {
      name: "revoked session",
      path: "/config-org/config-app/production/live",
      seed: true,
      revoke: true,
    },
    {
      name: "unauthorized App",
      path: "/config-org/other-config-app/production/live",
      seed: true,
    },
    {
      name: "unauthorized Environment",
      path: "/config-org/config-app/missing/live",
      seed: true,
    },
  ])("rejects $name at the panel boundary without a DO connector", async ({
    path,
    seed,
    revoke,
  }) => {
    const token = `spl_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const tokenHash = await hashToken(token);
    if (seed) await seedPanelSession(tokenHash);
    if (revoke) await env.SESSION_STORE.delete(`session:${tokenHash}`);
    const connect = vi.fn(async () => new Response(null, { status: 101 }));

    const request = new Request(`https://panel.test${path}`, {
      headers: {
        cookie: `__session=${token}`,
        origin: "https://panel.test",
        upgrade: "websocket",
      },
    });
    const response = await handleLiveUpdateUpgrade(request, {
      authorize: (upgradeRequest, params) =>
        authorizeLiveUpdateUpgrade(upgradeRequest, env, params),
      connect,
    });

    expect(response?.status).toBe(seed && !revoke ? 404 : 401);
    expect(connect).not.toHaveBeenCalled();
  });
});

async function seedPanelSession(sessionTokenHash: string): Promise<void> {
  await env.SESSION_STORE.put(
    `session:${sessionTokenHash}`,
    JSON.stringify({
      version: 2,
      userId: USER_ID,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
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
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seededLiveUpdateContext(
  options: { validForMs?: number; sessionTokenHash?: string } = {},
) {
  const sessionTokenHash = options.sessionTokenHash ?? "a".repeat(64);
  // Session expiry is stored and compared in whole seconds, so truncating the
  // deadline hands the caller only the milliseconds left in the current wall-clock
  // second: a validity window uniformly distributed over 0-1000ms rather than the
  // window it asked for (SPL-255). Round up so `validForMs` is a floor, not a
  // ceiling, and the window no longer depends on when the test happened to start.
  const expiresAt = Math.ceil(
    (Date.now() + (options.validForMs ?? DEFAULT_SESSION_VALIDITY_MS)) / 1_000,
  );
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

function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}
