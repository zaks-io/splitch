import {
  type AuthDoor,
  type PersonalAccessToken,
  PersonalAccessTokenCacheSchema,
  personalAccessTokenCacheKey,
} from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/credential-cache";
import { makeTestApp as createApp } from "../src/test-app-fixture";
import { allowLimiter } from "../src/test-constants";
import type { LocalBindings } from "../src/test-fixtures";
import { resetOrganizationGraph } from "../src/test-seeds";
import { makePoolBindings } from "./pool-bindings";

const USER_ID = "user_pat_auth_doors";
const grants = [{ target: "all", role: "owner", access: "read-write" }] as const;
let bindings: LocalBindings;
let app: ReturnType<typeof createApp>;
let principal: Principal;

beforeEach(async () => {
  bindings = await makePoolBindings();
  await resetOrganizationGraph(bindings.d1);
  principal = {
    kind: "control-plane-token",
    id: USER_ID,
    scopes: [],
    orgId: null,
    appId: null,
    environmentId: null,
    authDoor: "device_flow",
  };
  // Inject the resolved principal to exercise the handler gate directly. JWT
  // verification maps PAT and unknown claims to anonymous before this point.
  app = createApp({
    authResolver: () => ({ ok: true, principal }),
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    personalAccessTokenStore: bindings.kv,
  });
});

afterEach(async () => {
  await bindings.dispose();
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function create() {
  const response = await call("POST", "/personal-access-tokens", { name: "door", grants });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: PersonalAccessToken; secret: string };
}

async function cacheEntry(secret: string) {
  const raw = await bindings.kv.get(personalAccessTokenCacheKey(await sha256Hex(secret)));
  expect(raw).not.toBeNull();
  return PersonalAccessTokenCacheSchema.parse(JSON.parse(raw as string));
}

const refusedDoors = ["id_jag", "anonymous", "personal_access_token", null, "future_door"];

describe("personal access token management auth doors", () => {
  it.each(refusedDoors)("refuses create, update, and rotate for %s", async (door) => {
    const { token, secret } = await create();
    const repo = createRepository(bindings.d1).personalAccessTokens;
    const original = await repo.getForUser(USER_ID, token.id);
    const originalCache = await cacheEntry(secret);
    principal.authDoor = door as AuthDoor | null;

    for (const [method, path, body] of [
      ["POST", "/personal-access-tokens", { name: "blocked", grants, expiresAt: null }],
      ["PATCH", `/personal-access-tokens/${token.id}`, { grants, expiresAt: null }],
      ["POST", `/personal-access-tokens/${token.id}/rotate`, undefined],
    ] as const) {
      const response = await call(method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("device_flow or client_credentials"),
      });
      expect(await repo.getForUser(USER_ID, token.id)).toEqual(original);
      expect(await cacheEntry(secret)).toEqual(originalCache);
      expect(await repo.listActiveForUser(USER_ID)).toHaveLength(1);
    }
  });

  it.each(["device_flow", "client_credentials"] as const)(
    "allows create, update, and rotate for %s",
    async (door) => {
      principal.authDoor = door;
      const { token, secret } = await create();
      const updated = await call("PATCH", `/personal-access-tokens/${token.id}`, {
        grants,
        expiresAt: null,
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ grants, expiresAt: null, neverExpires: true });
      const rotated = await call("POST", `/personal-access-tokens/${token.id}/rotate`);
      expect(rotated.status).toBe(200);
      const result = (await rotated.json()) as { secret: string };
      expect(result.secret).not.toBe(secret);
      expect(await cacheEntry(secret)).toMatchObject({ revoked: true });
      expect(await cacheEntry(result.secret)).toMatchObject({ tokenId: token.id, revoked: false });
    },
  );

  it.each(refusedDoors)("keeps list, revoke, and revoke-all available for %s", async (door) => {
    const first = await create();
    const second = await create();
    principal.authDoor = door as AuthDoor | null;
    const listed = await call("GET", "/personal-access-tokens");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      items: expect.arrayContaining([{ ...first.token }]),
    });
    const revoked = await call("POST", `/personal-access-tokens/${first.token.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ status: "revoked" });
    expect(await cacheEntry(first.secret)).toMatchObject({ revoked: true });
    const all = await call("POST", "/personal-access-tokens/revoke-all");
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({ revokedCount: 1 });
    expect(await cacheEntry(second.secret)).toMatchObject({ revoked: true });
  });
});
