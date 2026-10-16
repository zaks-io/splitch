import { env } from "cloudflare:workers";
import { getRoute, personalAccessTokenPermissions } from "@splitch/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OWNER, TENANT_A, TENANT_B } from "./index-mcp-fixtures";
import { bearerFixture, repo, SECRET, TOKEN_ID } from "./personal-access-token-bearer-fixture";

let fixture: Awaited<ReturnType<typeof bearerFixture>>;
beforeAll(async () => {
  fixture = await bearerFixture();
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM personal_access_tokens").run();
  await fixture.seed();
  fixture.resetLimits();
});

const app = `/apps/${TENANT_A.appId}`;

describe("Personal Access Token on the Control Plane public bearer door", () => {
  it("reads only its granted App and exposes configured and effective authority separately", async () => {
    expect((await fixture.call("GET", app)).status).toBe(200);
    expect((await fixture.call("GET", `/apps/${TENANT_B.appId}`)).status).toBe(403);
    const response = await fixture.call("GET", "/principal/capabilities");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      scopes: [`app:${TENANT_A.appId}:admin`],
      membershipWideRead: true,
      personalAccessToken: { id: TOKEN_ID, permissions: expect.any(Object) },
      token: {
        id: TOKEN_ID,
        name: "CLI bearer fixture",
        grants: [{ target: `app:${TENANT_A.appId}`, role: "admin", permissions: ["write"] }],
        expiresAt: null,
        effective: {
          scopes: [`app:${TENANT_A.appId}:admin`],
          permissions: Object.fromEntries(
            personalAccessTokenPermissions.map((permission) => [
              permission,
              { scopes: permission === "write" ? [`app:${TENANT_A.appId}:admin`] : [], all: false },
            ]),
          ),
        },
      },
    });
    expect(getRoute("principal_capabilities_get")?.output.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain("spl_pat_");
  });

  it.each(["revoked", "expired", "rotated"])(
    "refuses a %s D1 row with stale active KV",
    async (state) => {
      if (state === "revoked")
        await repo().personalAccessTokens.revoke(OWNER, TOKEN_ID, new Date().toISOString());
      if (state === "expired")
        await repo().personalAccessTokens.update(OWNER, TOKEN_ID, {
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
      if (state === "rotated") {
        const original = await repo().personalAccessTokens.getById(TOKEN_ID);
        if (!original) throw new Error("fixture PAT row missing");
        await repo().personalAccessTokens.rotate(OWNER, TOKEN_ID, {
          tokenHash: "b".repeat(64),
          rotatedAt: new Date().toISOString(),
          previousHash: original.tokenHash,
        });
      }
      const response = await fixture.call("GET", app);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "CREDENTIAL_REVOKED" });
      expect(fixture.reads).toHaveBeenCalledTimes(1);
    },
  );

  it("sees grant narrowing and live membership demotion on the next request", async () => {
    await env.DB.prepare(
      "UPDATE app_memberships SET role = 'member' WHERE app_id = ? AND user_id = ?",
    )
      .bind(TENANT_A.appId, OWNER)
      .run();
    try {
      const response = await fixture.call("GET", "/principal/capabilities");
      expect(await response.json()).toMatchObject({
        token: {
          grants: [{ role: "admin" }],
          effective: { scopes: [`app:${TENANT_A.appId}:member`] },
        },
      });
      const denied = await fixture.call("PATCH", app, { name: "Refused rename" });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "INSUFFICIENT_SCOPES" });
    } finally {
      await env.DB.prepare(
        "UPDATE app_memberships SET role = 'owner' WHERE app_id = ? AND user_id = ?",
      )
        .bind(TENANT_A.appId, OWNER)
        .run();
    }
    await repo().personalAccessTokens.update(OWNER, TOKEN_ID, {
      grants: JSON.stringify([
        { target: `app:${TENANT_B.appId}`, role: "admin", permissions: ["write"] },
      ]),
    });
    expect((await fixture.call("GET", app)).status).toBe(403);
  });

  it("keeps owner cleanup available to an App-only read token", async () => {
    await repo().personalAccessTokens.update(OWNER, TOKEN_ID, {
      grants: JSON.stringify([
        { target: `app:${TENANT_A.appId}`, role: "member", permissions: [] },
      ]),
    });
    expect((await fixture.call("GET", "/personal-access-tokens")).status).toBe(200);
    expect((await fixture.call("POST", `/personal-access-tokens/${TOKEN_ID}/revoke`)).status).toBe(
      200,
    );
    const next = await fixture.call("GET", app);
    expect(next.status).toBeGreaterThanOrEqual(400);
  });

  it.each([
    [
      "POST",
      "/personal-access-tokens",
      { name: "forbidden", grants: [{ target: "all", role: "admin", permissions: [] }] },
    ],
    ["PATCH", `/personal-access-tokens/${TOKEN_ID}`, { name: "forbidden" }],
    ["POST", `/personal-access-tokens/${TOKEN_ID}/rotate`, undefined],
    ["DELETE", "/users/me", undefined],
  ])("requires a login session for %s %s", async (method, path, body) => {
    const response = await fixture.call(method as string, path as string, body);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("unset SPLITCH_TOKEN and run splitch login"),
    });
    expect((await repo().personalAccessTokens.getById(TOKEN_ID))?.revokedAt).toBeNull();
  });
});

describe("PAT abuse limits", () => {
  it.each(["local", "shared-preview", "production"])(
    "charges the address before KV and actor before permission refusals on %s",
    async (target) => {
      fixture.bindings.SPLITCH_PLATFORM_TARGET = target;
      fixture.resetLimits(2, 2);
      for (let n = 0; n < 2; n++)
        expect(
          (await fixture.call("GET", app, undefined, `spl_pat_${"f".repeat(64)}`)).status,
        ).toBe(401);
      const throttled = await fixture.call("GET", app, undefined, `spl_pat_${"f".repeat(64)}`);
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toBe("60");
      expect(fixture.reads).toHaveBeenCalledTimes(2);
      // Two valid credentials share the owner counter despite different addresses.
      const second = `spl_pat_${"4".repeat(64)}`;
      await fixture.seed(undefined, second, `pat_${"4".repeat(32)}`);
      fixture.resetLimits(Infinity, 2);
      const path = `${app}/envs/${TENANT_A.environmentId}/api-keys`;
      for (const secret of [SECRET, second]) {
        const denied = await fixture.call(
          "POST",
          path,
          { scopes: ["data-plane:evaluate"] },
          secret,
        );
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({
          code: "FORBIDDEN",
          message: expect.stringContaining("credentials"),
        });
      }
      expect(
        (
          await fixture.call(
            "POST",
            path,
            { scopes: ["data-plane:evaluate"] },
            second,
            "192.0.2.11",
          )
        ).status,
      ).toBe(429);
      expect(
        fixture.limit.mock.calls.filter(([arg]) => arg.key === `control-plane-token:${OWNER}`),
      ).toHaveLength(3);
    },
  );
});
