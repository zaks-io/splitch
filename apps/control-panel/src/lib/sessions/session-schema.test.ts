import { describe, expect, it } from "vitest";
import { createSession, loadSessionFromCookieHeader, sessionKey } from "#lib/sessions/session";
import { MemoryKv, NOW, sessionPrincipal } from "#lib/sessions/session-test-harness";

describe("control-panel stored session validation", () => {
  it.each([
    ["an empty refresh token", { workosRefreshToken: "" }],
    ["a zero access token expiry", { workosAccessTokenExpiresAt: 0 }],
    ["a string access token expiry", { workosAccessTokenExpiresAt: "1760000000" }],
  ])("deletes a v2 or v1 session carrying %s", async (_name, badFields) => {
    for (const version of [2, undefined]) {
      const kv = new MemoryKv();
      const created = await createSession(kv.namespace(), sessionPrincipal(), NOW);
      kv.store.set(
        sessionKey(created.tokenHash),
        JSON.stringify({ ...created.session, ...badFields, version }),
      );

      const loaded = await loadSessionFromCookieHeader(kv.namespace(), created.cookie, NOW);

      expect(loaded).toEqual({ ok: false, reason: "invalid" });
      expect(kv.store.has(sessionKey(created.tokenHash))).toBe(false);
    }
  });
});
