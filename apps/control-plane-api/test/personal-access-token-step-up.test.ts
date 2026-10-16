import {
  PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE,
  personalAccessTokenCacheKey,
} from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP,
  broadGrant,
  OTHER_APP,
  readGrant,
  stepUpFixture,
  USER,
} from "./personal-access-token-step-up-fixture";

let f: Awaited<ReturnType<typeof stepUpFixture>>;
beforeEach(async () => {
  f = await stepUpFixture();
});
afterEach(async () => {
  await f.bindings.dispose();
  vi.restoreAllMocks();
});

describe("PAT step-up through the real D1 route", () => {
  it.each([
    "all",
    "outside scope",
    "higher ceiling",
    "read token writes",
    "permanent",
    "widening",
    "broad rotation",
    "permanent rotation",
  ])("refuses %s without writes and accepts independent fresh approval", async (trigger) => {
    const seeded = await f.seed([readGrant], new Date(f.now() + 3600_000).toISOString());
    let method = "POST";
    let path = "/personal-access-tokens";
    let body: unknown = { name: "approved", grants: [readGrant] };
    const claims: Record<string, unknown> = {};
    if (trigger === "all") body = { name: "all", grants: [broadGrant] };
    if (trigger === "outside scope")
      body = { name: "other", grants: [{ ...readGrant, target: `app:${OTHER_APP}` }] };
    if (trigger === "higher ceiling")
      body = { name: "admin", grants: [{ ...readGrant, role: "admin" }] };
    if (trigger === "read token writes") {
      body = { name: "write", grants: [{ ...readGrant, permissions: ["write"] }] };
      Object.assign(claims, { authorization: "membership-wide-read", scopes: [] });
    }
    if (trigger === "permanent") body = { name: "never", grants: [readGrant], expiresAt: null };
    if (trigger === "widening") {
      method = "PATCH";
      path += `/${seeded.row.id}`;
      body = { grants: [{ ...readGrant, permissions: ["write"] }] };
    }
    if (trigger.includes("rotation")) {
      await f.repo.personalAccessTokens.update(
        USER,
        seeded.row.id,
        trigger === "broad rotation"
          ? { grants: JSON.stringify([broadGrant]) }
          : { expiresAt: null },
      );
      path += `/${seeded.row.id}/rotate`;
      body = undefined;
    }
    const before = await f.repo.personalAccessTokens.listForUser(USER, { limit: 100 });
    const refused = await f.call(method, path, body, { claims });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("WWW-Authenticate")).toBe(PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE);
    expect(await refused.json()).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("rerun the same splitch tokens command"),
    });
    expect(await f.repo.personalAccessTokens.listForUser(USER, { limit: 100 })).toEqual(before);
    expect(f.puts).toEqual([]);
    expect(
      (
        await f.bindings.d1
          .prepare("SELECT count(*) AS n FROM personal_access_token_step_up_uses")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    const approved = await f.call(method, path, body, { claims, approval: await f.approval() });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(approved.headers.has("WWW-Authenticate")).toBe(false);
  });

  it("ordinary finite issuance and cleanup of a broad permanent token remain available", async () => {
    const response = await f.call("POST", "/personal-access-tokens", {
      name: "scoped",
      grants: [readGrant],
    });
    expect(response.status).toBe(200);
    const { row } = await f.seed();
    for (const authDoor of ["device_flow", "client_credentials", "id_jag", "anonymous"]) {
      const current = await f.seed();
      const narrowed = await f.call(
        "PATCH",
        `/personal-access-tokens/${current.row.id}`,
        { grants: [{ ...broadGrant, permissions: [] }] },
        { claims: { auth_door: authDoor } },
      );
      expect(narrowed.status).toBe(200);
      expect(
        (
          await f.call("GET", "/personal-access-tokens", undefined, {
            claims: { auth_door: authDoor },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await f.call("POST", `/personal-access-tokens/${current.row.id}/revoke`, undefined, {
            claims: { auth_door: authDoor },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await f.call("POST", "/personal-access-tokens/revoke-all", undefined, {
            claims: { auth_door: authDoor },
          })
        ).status,
      ).toBe(200);
    }
    expect((await f.repo.personalAccessTokens.getForUser(USER, row.id))?.revokedAt).not.toBeNull();
  });

  it.each([
    { sub: "another_user" },
    { iat: 1, exp: 301 },
    { iat: Math.floor(Date.now() / 1000) - 301 },
    { auth_door: "client_credentials" },
    { authorization: "membership-wide-read" },
    { jti: undefined },
    { scopes: [`app:${APP}:owner`] },
    { iss: "https://untrusted.example" },
    { aud: "https://other.example" },
  ])("refuses invalid binding %j without a PAT or KV write", async (claims) => {
    const response = await f.call(
      "POST",
      "/personal-access-tokens",
      { name: "blocked", grants: [broadGrant] },
      { approval: await f.approval(claims) },
    );
    expect(response.status).toBe(403);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(f.puts).toEqual([]);
    expect(await f.repo.personalAccessTokens.listActiveForUser(USER)).toEqual([]);
  });

  it("refuses a forged signature, management bearer, and approval on another route", async () => {
    const otherSigner = await import("../src/fixture-signer").then((m) => m.makeFixtureSigner());
    const forged = await otherSigner.sign({ sub: USER, authorization: "pat-management" });
    const body = { name: "blocked", grants: [broadGrant] };
    expect(
      (await f.call("POST", "/personal-access-tokens", body, { approval: forged })).status,
    ).toBe(403);
    const approval = await f.approval();
    expect(
      (await f.call("GET", "/personal-access-tokens", undefined, { bearer: approval })).status,
    ).toBe(401);
    expect((await f.call("GET", "/orgs", undefined, { approval })).status).toBe(403);
    expect(f.puts).toEqual([]);
  });

  it("one jti permits exactly one concurrent D1 create and cannot be replayed", async () => {
    const approval = await f.approval();
    const body = { name: "once", grants: [broadGrant], expiresAt: null };
    const results = await Promise.all([
      f.call("POST", "/personal-access-tokens", body, { approval }),
      f.call("POST", "/personal-access-tokens", body, { approval }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(results.every((r) => !r.headers.has("WWW-Authenticate"))).toBe(true);
    const rows = await f.repo.personalAccessTokens.listActiveForUser(USER);
    expect(rows).toHaveLength(1);
    expect(f.puts).toHaveLength(1);
    expect((await f.call("POST", "/personal-access-tokens", body, { approval })).status).toBe(403);
    expect(await f.repo.personalAccessTokens.listActiveForUser(USER)).toEqual(rows);
    expect(f.puts).toHaveLength(1);
  });

  it("update consumes approval in the D1 transaction and replay writes nothing", async () => {
    const { row } = await f.seed([readGrant], new Date(f.now() + 3600_000).toISOString());
    const approval = await f.approval();
    const body = { grants: [broadGrant], expiresAt: null };
    const path = `/personal-access-tokens/${row.id}`;
    const responses = await Promise.all([
      f.call("PATCH", path, body, { approval }),
      f.call("PATCH", path, body, { approval }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(responses.every((r) => !r.headers.has("WWW-Authenticate"))).toBe(true);
    const updated = await f.repo.personalAccessTokens.getForUser(USER, row.id);
    const calls = f.puts.length;
    expect((await f.call("PATCH", path, body, { approval })).status).toBe(403);
    expect(await f.repo.personalAccessTokens.getForUser(USER, row.id)).toEqual(updated);
    expect(f.puts).toHaveLength(calls);
  });

  it("preserves the scoped one-hour client_credentials smoke and refuses all/never", async () => {
    const claims = { auth_door: "client_credentials", scopes: ["org:org_step_up:owner"] };
    const body = {
      name: "smoke",
      grants: [
        {
          target: "org:org_step_up",
          role: "admin",
          permissions: ["write", "delete", "credentials", "members", "privacy"],
        },
      ],
      expiresAt: new Date(f.now() + 3600_000).toISOString(),
    };
    const response = await f.call("POST", "/personal-access-tokens", body, { claims });
    expect(response.status).toBe(200);
    const { token, secret } = await f.created(response);
    expect(
      (await f.call("POST", `/personal-access-tokens/${token.id}/rotate`, undefined, { claims }))
        .status,
    ).toBe(200);
    expect(
      (
        await f.call(
          "PATCH",
          `/personal-access-tokens/${token.id}`,
          { name: "renamed" },
          { claims },
        )
      ).status,
    ).toBe(200);
    const calls = f.puts.length;
    for (const extra of [{ grants: [broadGrant] }, { expiresAt: null }]) {
      expect(
        (await f.call("POST", "/personal-access-tokens", { ...body, ...extra }, { claims })).status,
      ).toBe(403);
    }
    expect(
      (
        await f.call(
          "POST",
          "/personal-access-tokens",
          { ...body, expiresAt: null },
          { claims, approval: await f.approval() },
        )
      ).status,
    ).toBe(403);
    expect(f.puts).toHaveLength(calls);
    expect(
      await f.bindings.kv.get(
        personalAccessTokenCacheKey(
          await import("../src/credential-cache").then((m) => m.sha256Hex(secret)),
        ),
      ),
    ).not.toBeNull();
  });

  it("documents and permits the dedicated header without emitting either secret", async () => {
    const output: unknown[] = [];
    for (const method of ["log", "warn", "error", "info", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        output.push(args);
      });
    const approval = await f.approval();
    const response = await f.call(
      "POST",
      "/personal-access-tokens",
      { name: "private", grants: [broadGrant] },
      { approval },
    );
    expect(response.status).toBe(200);
    const { secret } = await f.created(response);
    expect(JSON.stringify([...f.events, ...output])).not.toContain(approval);
    expect(JSON.stringify([...f.events, ...output])).not.toContain(secret);
    const preflight = await f.app().request("/personal-access-tokens", {
      method: "OPTIONS",
      headers: {
        origin: "https://example.test",
        "access-control-request-headers": "splitch-pat-authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "splitch-pat-authorization",
    );
  });
});
