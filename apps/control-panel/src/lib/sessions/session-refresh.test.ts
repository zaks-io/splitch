import { OauthException } from "@workos-inc/node/worker";
import { describe, expect, it, vi } from "vitest";
import type { AuthKitClient } from "#lib/auth/authkit";
import type { ControlPanelBindings } from "#lib/shared/bindings";
import { createSession, sessionKey } from "#lib/sessions/session";
import { loadSessionFromRequest } from "#lib/sessions/session-refresh";
import { MemoryKv, NOW, sessionPrincipal } from "#lib/sessions/session-test-harness";

const NOW_SECONDS = Math.floor(NOW / 1_000);

describe("control-panel WorkOS access token refresh", () => {
  it("returns a fresh access token session unchanged without calling WorkOS or touching KV", async () => {
    const kv = new MemoryKv();
    const created = await refreshableSession(kv, NOW_SECONDS + 300);
    const storedBefore = kv.store.get(sessionKey(created.tokenHash));
    const refresh = vi.fn<AuthKitClient["authenticateWithRefreshToken"]>();

    const loaded = await loadSessionFromRequest(bindings(kv), request(created.cookie), NOW, {
      authKit: fakeAuthKit(refresh),
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(loaded).toEqual({ ok: true, session: created.session, tokenHash: created.tokenHash });
    expect(kv.store.get(sessionKey(created.tokenHash))).toBe(storedBefore);
  });

  it("rotates expired WorkOS tokens in the same absolute panel session", async () => {
    const kv = new MemoryKv();
    const created = await refreshableSession(kv, NOW_SECONDS - 1);
    const newAccessTokenExpiresAt = NOW_SECONDS + 3_600;
    const newAccessToken = jwt({ sid: "workos_session_2", exp: newAccessTokenExpiresAt });
    const refresh = vi.fn<AuthKitClient["authenticateWithRefreshToken"]>(async () => ({
      accessToken: newAccessToken,
      refreshToken: "refresh_token_2",
    }));

    const loaded = await loadSessionFromRequest(bindings(kv), request(created.cookie), NOW, {
      authKit: fakeAuthKit(refresh),
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith({
      clientId: "client_test",
      refreshToken: "refresh_token_1",
      ipAddress: "203.0.113.10",
      userAgent: "vitest",
    });
    expect(loaded).toEqual({
      ok: true,
      tokenHash: created.tokenHash,
      session: {
        ...created.session,
        workosAccessToken: newAccessToken,
        workosRefreshToken: "refresh_token_2",
        workosAccessTokenExpiresAt: newAccessTokenExpiresAt,
        workosSessionId: "workos_session_2",
      },
    });
    expect([...kv.store.keys()]).toEqual([sessionKey(created.tokenHash)]);
    expect(JSON.parse(kv.store.get(sessionKey(created.tokenHash)) ?? "null")).toMatchObject({
      expiresAt: created.session.expiresAt,
      workosAccessToken: newAccessToken,
      workosRefreshToken: "refresh_token_2",
      workosAccessTokenExpiresAt: newAccessTokenExpiresAt,
      workosSessionId: "workos_session_2",
    });
  });

  it("returns a session without refresh credentials unchanged", async () => {
    const kv = new MemoryKv();
    const created = await createSession(kv.namespace(), sessionPrincipal(), NOW);
    const refresh = vi.fn<AuthKitClient["authenticateWithRefreshToken"]>();

    const loaded = await loadSessionFromRequest(bindings(kv), request(created.cookie), NOW, {
      authKit: fakeAuthKit(refresh),
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(loaded).toEqual({ ok: true, session: created.session, tokenHash: created.tokenHash });
  });

  it.each(["invalid_grant", "mfa_enrollment", "sso_required"])(
    "ends the session without touching KV when WorkOS answers %s",
    async (error) => {
      const kv = new MemoryKv();
      const created = await refreshableSession(kv, NOW_SECONDS - 1);
      const storedBefore = kv.store.get(sessionKey(created.tokenHash));
      const refresh = vi.fn<AuthKitClient["authenticateWithRefreshToken"]>(async () => {
        throw oauthException(error);
      });

      const loaded = await loadSessionFromRequest(bindings(kv), request(created.cookie), NOW, {
        authKit: fakeAuthKit(refresh),
      });

      expect(loaded).toEqual({ ok: false, reason: "expired" });
      expect(kv.store.get(sessionKey(created.tokenHash))).toBe(storedBefore);
    },
  );

  it("rethrows an OAuth error that is not a session ending, so misconfiguration fails loud", async () => {
    const kv = new MemoryKv();
    const created = await refreshableSession(kv, NOW_SECONDS - 1);
    const storedBefore = kv.store.get(sessionKey(created.tokenHash));
    const failure = oauthException("invalid_client");
    const refresh = vi.fn<AuthKitClient["authenticateWithRefreshToken"]>(async () => {
      throw failure;
    });

    await expect(
      loadSessionFromRequest(bindings(kv), request(created.cookie), NOW, {
        authKit: fakeAuthKit(refresh),
      }),
    ).rejects.toBe(failure);
    expect(kv.store.get(sessionKey(created.tokenHash))).toBe(storedBefore);
  });

  it("rethrows non-OAuth refresh failures without touching the session", async () => {
    const kv = new MemoryKv();
    const created = await refreshableSession(kv, NOW_SECONDS - 1);
    const storedBefore = kv.store.get(sessionKey(created.tokenHash));
    const failure = new Error("WorkOS unavailable");
    const refresh = vi.fn<AuthKitClient["authenticateWithRefreshToken"]>(async () => {
      throw failure;
    });

    await expect(
      loadSessionFromRequest(bindings(kv), request(created.cookie), NOW, {
        authKit: fakeAuthKit(refresh),
      }),
    ).rejects.toBe(failure);
    expect(kv.store.get(sessionKey(created.tokenHash))).toBe(storedBefore);
  });
});

async function refreshableSession(kv: MemoryKv, accessTokenExpiresAt: number) {
  return createSession(
    kv.namespace(),
    {
      ...sessionPrincipal(),
      workosAccessToken: "access_token_1",
      workosRefreshToken: "refresh_token_1",
      workosAccessTokenExpiresAt: accessTokenExpiresAt,
    },
    NOW,
  );
}

function bindings(kv: MemoryKv): ControlPanelBindings {
  return {
    DB: {} as D1Database,
    SESSION_STORE: kv.namespace(),
    WORKOS_API_KEY: "sk_test",
    WORKOS_CLIENT_ID: "client_test",
    AUTH_API_ORIGIN: "https://auth.splitch.test",
    EVALUATION_API_ORIGIN: "https://edge.splitch.test",
  };
}

function request(cookie: string): Request {
  return new Request("https://panel.splitch.test/acme", {
    headers: {
      cookie,
      "cf-connecting-ip": "203.0.113.10",
      "user-agent": "vitest",
    },
  });
}

function fakeAuthKit(
  authenticateWithRefreshToken: AuthKitClient["authenticateWithRefreshToken"],
): AuthKitClient {
  return {
    authenticateWithCode: async () => {
      throw new Error("authenticateWithCode is not used by session refresh");
    },
    authenticateWithRefreshToken,
    getAuthorizationUrl: () => "https://workos.example/authorize",
    getLogoutUrl: () => "https://workos.example/logout",
  };
}

function oauthException(error: string): OauthException {
  return new OauthException(400, "request_1", error, "Refresh refused", {});
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
