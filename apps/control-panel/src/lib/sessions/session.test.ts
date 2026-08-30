import { describe, expect, it } from "vitest";
import {
  consumeOAuthState,
  createOAuthState,
  OAUTH_STATE_COOKIE_NAME,
} from "#lib/auth/oauth-state";
import {
  createSession,
  loadSessionFromCookieHeader,
  PANEL_SESSION_MAX_SECONDS,
  publicSession,
  refreshSession,
  SESSION_COOKIE_NAME,
  sessionKey,
} from "#lib/sessions/session";
import { MemoryKv, NOW, sessionPrincipal } from "#lib/sessions/session-test-harness";

describe("control-panel session cookie and KV validation", () => {
  it("stores an opaque Secure HttpOnly session cookie that maps to one KV principal", async () => {
    const kv = new MemoryKv();
    const created = await createSession(kv.namespace(), sessionPrincipal(), NOW);

    expect(created.cookie).toContain(`${SESSION_COOKIE_NAME}=spl_`);
    expect(created.cookie).toContain("HttpOnly");
    expect(created.cookie).toContain("Secure");
    expect(created.cookie).toContain("SameSite=Lax");
    expect(created.cookie).toContain("Path=/");
    expect(created.cookie).toContain(`Max-Age=${PANEL_SESSION_MAX_SECONDS}`);
    expect(created.cookie).not.toContain("user_1");
    expect(created.cookie).not.toContain("app_1");

    expect(kv.store.size).toBe(1);
    expect(kv.store.has(sessionKey(created.tokenHash))).toBe(true);
    expect(created.session.expiresAt).toBe(Math.floor(NOW / 1000) + PANEL_SESSION_MAX_SECONDS);

    const loaded = await loadSessionFromCookieHeader(kv.namespace(), created.cookie, NOW);
    expect(loaded).toMatchObject({
      ok: true,
      session: {
        userId: "user_1",
        orgs: [
          {
            orgId: "org_1",
            orgSlug: "acme",
            apps: [{ appId: "app_1", appSlug: "checkout-api" }],
          },
        ],
      },
    });
  });

  it("keeps WorkOS refresh credentials out of the public session", async () => {
    const created = await createSession(
      new MemoryKv().namespace(),
      {
        ...sessionPrincipal(),
        workosAccessToken: "access_token_1",
        workosRefreshToken: "refresh_token_1",
        workosAccessTokenExpiresAt: Math.floor(NOW / 1000) + 300,
      },
      NOW,
    );

    const session = publicSession(created.session);

    expect(session).not.toHaveProperty("workosRefreshToken");
    expect(session).not.toHaveProperty("workosAccessTokenExpiresAt");
  });

  it("clamps an explicit expiry to the absolute panel session cap", async () => {
    const created = await createSession(
      new MemoryKv().namespace(),
      {
        ...sessionPrincipal(),
        expiresAt: Math.floor(NOW / 1_000) + PANEL_SESSION_MAX_SECONDS * 2,
      },
      NOW,
    );

    expect(created.session.expiresAt).toBe(Math.floor(NOW / 1_000) + PANEL_SESSION_MAX_SECONDS);
    expect(created.cookie).toContain(`Max-Age=${PANEL_SESSION_MAX_SECONDS}`);
  });

  it("rejects a tampered token without returning a principal", async () => {
    const kv = new MemoryKv();
    await createSession(kv.namespace(), sessionPrincipal(), NOW);

    const tampered = `${SESSION_COOKIE_NAME}=spl_${"a".repeat(64)}`;

    await expect(loadSessionFromCookieHeader(kv.namespace(), tampered, NOW)).resolves.toEqual({
      ok: false,
      reason: "tampered",
    });
  });

  it("deletes expired sessions and fails loud", async () => {
    const kv = new MemoryKv();
    const created = await createSession(kv.namespace(), sessionPrincipal(), NOW);
    kv.store.set(
      sessionKey(created.tokenHash),
      JSON.stringify({
        ...created.session,
        expiresAt: Math.floor(NOW / 1000) - 1,
      }),
    );

    const loaded = await loadSessionFromCookieHeader(kv.namespace(), created.cookie, NOW);

    expect(loaded).toEqual({ ok: false, reason: "expired" });
    expect(kv.store.has(sessionKey(created.tokenHash))).toBe(false);
  });

  it("deletes malformed session principals with hidden scope fields", async () => {
    const kv = new MemoryKv();
    const created = await createSession(kv.namespace(), sessionPrincipal(), NOW);
    const sessionWithNestedScope = structuredClone(created.session);
    Object.assign(sessionWithNestedScope.orgs[0]?.apps[0] ?? {}, {
      environmentId: "hidden-default-env",
    });
    kv.store.set(
      sessionKey(created.tokenHash),
      JSON.stringify({
        ...sessionWithNestedScope,
        appId: "hidden-default-app",
      }),
    );

    const loaded = await loadSessionFromCookieHeader(kv.namespace(), created.cookie, NOW);

    expect(loaded).toEqual({ ok: false, reason: "invalid" });
    expect(kv.store.has(sessionKey(created.tokenHash))).toBe(false);
  });

  it("refreshes the same session after a claim so provisional state is not stale", async () => {
    const kv = new MemoryKv();
    const created = await createSession(
      kv.namespace(),
      { ...sessionPrincipal(), workosAccessToken: "workos-access-token" },
      NOW,
    );
    const claimed = structuredClone(created.session);
    const organization = claimed.orgs[0];
    if (!organization) {
      throw new Error("expected an Organization in the test session");
    }
    organization.isProvisional = false;
    organization.demoExpiresAt = null;

    await refreshSession(kv.namespace(), created.tokenHash, claimed, NOW);

    await expect(loadSessionFromCookieHeader(kv.namespace(), created.cookie, NOW)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        session: expect.objectContaining({
          orgs: [expect.objectContaining({ demoExpiresAt: null, isProvisional: false })],
          workosAccessToken: "workos-access-token",
          version: 2,
        }),
      }),
    );
  });

  it("accepts a v1 session and marks it for server-side membership rehydration", async () => {
    const kv = new MemoryKv();
    const created = await createSession(kv.namespace(), sessionPrincipal(), NOW);
    kv.store.set(
      sessionKey(created.tokenHash),
      JSON.stringify({
        userId: created.session.userId,
        expiresAt: created.session.expiresAt,
        workosSessionId: created.session.workosSessionId,
        orgs: created.session.orgs.map(
          ({ isProvisional: _isProvisional, demoExpiresAt: _demo, ...org }) => org,
        ),
      }),
    );

    await expect(
      loadSessionFromCookieHeader(kv.namespace(), created.cookie, NOW),
    ).resolves.toMatchObject({
      ok: true,
      session: {
        version: 1,
        orgs: [expect.objectContaining({ demoExpiresAt: null, isProvisional: false })],
      },
    });
  });
});

describe("OAuth state cookie", () => {
  it("keeps returnTo server-side and requires callback state to match the cookie", async () => {
    const kv = new MemoryKv();
    const state = await createOAuthState(kv.namespace(), "/acme/checkout-api/dev", NOW);

    expect(state.cookie).toContain(`${OAUTH_STATE_COOKIE_NAME}=spl_`);
    expect(state.cookie).toContain("HttpOnly");
    expect(state.cookie).toContain("Secure");
    expect(state.cookie).toContain("SameSite=Lax");
    expect(state.cookie).toContain("Path=/");
    expect(state.cookie).not.toContain("checkout-api");

    const request = new Request(`https://app.splitch.dev/auth/callback?state=${state.state}`, {
      headers: { cookie: state.cookie },
    });
    const consumed = await consumeOAuthState(kv.namespace(), request, state.state, NOW);

    expect(consumed).toMatchObject({
      ok: true,
      returnTo: "/acme/checkout-api/dev",
    });
    expect(kv.store.size).toBe(0);
  });

  it("rejects mismatched callback state", async () => {
    const kv = new MemoryKv();
    const state = await createOAuthState(kv.namespace(), "/", NOW);
    const request = new Request("https://app.splitch.dev/auth/callback?state=wrong", {
      headers: { cookie: state.cookie },
    });

    await expect(
      consumeOAuthState(kv.namespace(), request, `spl_${"b".repeat(64)}`, NOW),
    ).resolves.toMatchObject({
      ok: false,
    });
  });

  it("sanitizes the server-side return path again when state is consumed", async () => {
    const kv = new MemoryKv();
    const state = await createOAuthState(kv.namespace(), "/", NOW);
    const [key] = kv.store.keys();
    if (!key) {
      throw new Error("expected OAuth state to be stored");
    }
    kv.store.set(
      key,
      JSON.stringify({
        expiresAt: Math.floor(NOW / 1000) + 60,
        returnTo: "https://evil.example/phish",
      }),
    );
    const request = new Request(`https://app.splitch.dev/auth/callback?state=${state.state}`, {
      headers: { cookie: state.cookie },
    });

    await expect(
      consumeOAuthState(kv.namespace(), request, state.state, NOW),
    ).resolves.toMatchObject({
      ok: true,
      returnTo: "/",
    });
  });
});
