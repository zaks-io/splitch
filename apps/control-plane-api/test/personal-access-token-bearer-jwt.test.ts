import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { withPersonalAccessTokenBearer } from "../src/personal-access-token-auth";
import { makePersonalAccessTokenAuthorityResolver } from "../src/personal-access-token-store";
import { rateLimiterForTarget } from "../src/rate-limit";
import { makeSessionStore } from "../src/session-store";
import { makeTestApp } from "../src/test-app-fixture";
import { AUDIENCE, ISSUER } from "../src/test-constants";
import { makeTokenMembershipAccess } from "../src/token-membership";
import { OWNER, TENANT_A } from "./index-mcp-fixtures";
import { bearerFixture } from "./personal-access-token-bearer-fixture";

let fixture: Awaited<ReturnType<typeof bearerFixture>>;
let signer: FixtureSigner;
beforeAll(async () => {
  fixture = await bearerFixture();
  signer = await makeFixtureSigner();
});

it.each([false, true])(
  "keeps JWT device-flow capabilities unchanged, membership-wide=%s",
  async (wide) => {
    const repo = createRepository(fixture.bindings.DB);
    const membershipAccess = makeTokenMembershipAccess(repo);
    const scopes = wide ? [] : [`app:${TENANT_A.appId}:admin`];
    const token = await signer.sign({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: OWNER,
      auth_door: "device_flow",
      scopes,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(wide ? { authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION } : {}),
    });
    const fallback = makeControlPlaneAuthResolver({
      verifier: makeJwksVerifier({
        issuer: ISSUER,
        controlPlaneAudience: AUDIENCE,
        fetchJwks: async () => signer.jwks,
      }),
      sessions: makeSessionStore(fixture.bindings.SESSION_STORE),
      membershipAccess,
    });
    const patLimit = vi.fn(() => ({ limited: false as const }));
    const wrapped = withPersonalAccessTokenBearer({
      fallback,
      store: fixture.bindings.SESSION_STORE,
      resolve: makePersonalAccessTokenAuthorityResolver({
        repo,
        membershipAccess,
        nowMs: Date.now,
      }),
      rateLimiter: patLimit,
    });
    const request = new Request(`${AUDIENCE}/principal/capabilities`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await wrapped(request)).toEqual(await fallback(request));
    expect(patLimit).not.toHaveBeenCalled();
    const response = await makeTestApp({
      repo,
      authResolver: wrapped,
      rateLimiter: rateLimiterForTarget("local", fixture.bindings.CONTROL_PLANE_ACTOR_RATE_LIMITER),
    }).fetch(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scopes: wide ? [`app:${TENANT_A.appId}:owner`, `org:${TENANT_A.orgId}:owner`].sort() : scopes,
      membershipWideRead: wide,
    });
  },
);

describe("exact PAT routing and fail-closed attempts", () => {
  it.each([
    "Bearer spl_pat_short",
    `Bearer spl_pat_${"A".repeat(64)}`,
    "Bearer jwt.original.bytes",
    "Basic credential",
  ])("passes other bearer forms unchanged to the existing resolver", async (authorization) => {
    const request = new Request(AUDIENCE, { headers: { authorization } });
    const fallback = vi.fn(() => ({ ok: false as const, reason: "UNAUTHORIZED" as const }));
    const get = vi.fn();
    const limiter = vi.fn();
    const resolver = withPersonalAccessTokenBearer({
      fallback,
      store: { get } as Pick<KVNamespace, "get">,
      resolve: vi.fn(),
      rateLimiter: limiter,
    });
    expect(await resolver(request)).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(fallback).toHaveBeenCalledWith(request);
    expect(get).not.toHaveBeenCalled();
    expect(limiter).not.toHaveBeenCalled();
  });

  it("rejects before KV when the real limiter binding throws", async () => {
    const get = vi.fn();
    const resolver = withPersonalAccessTokenBearer({
      fallback: vi.fn(),
      store: { get } as Pick<KVNamespace, "get">,
      resolve: vi.fn(),
      rateLimiter: rateLimiterForTarget("production", {
        limit: async () => {
          throw new Error("binding unavailable");
        },
      } as RateLimit),
    });
    const result = await resolver(
      new Request(AUDIENCE, { headers: { authorization: `Bearer spl_pat_${"a".repeat(64)}` } }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(get).not.toHaveBeenCalled();
  });
});
