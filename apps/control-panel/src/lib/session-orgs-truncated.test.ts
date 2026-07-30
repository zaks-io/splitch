import { describe, expect, it } from "vitest";
import { createSession, loadSessionFromCookieHeader, sessionKey } from "./session";
import { MemoryKv, NOW, sessionPrincipal } from "./session-test-harness";

describe("stored session orgsTruncated validation", () => {
  // The key allowlist admits `orgsTruncated` and `normalizeStoredSession` spreads
  // the candidate through, so the v1 path has to type-check it too. Without that
  // a v1 session smuggles a non-boolean past validation that the identical v2
  // session is correctly refused for.
  it("refuses a v1 session carrying a non-boolean orgsTruncated", async () => {
    const kv = new MemoryKv();
    const created = await createSession(kv.namespace(), sessionPrincipal(), NOW);
    kv.store.set(
      sessionKey(created.tokenHash),
      JSON.stringify({
        userId: created.session.userId,
        expiresAt: created.session.expiresAt,
        workosSessionId: created.session.workosSessionId,
        orgsTruncated: "definitely",
        orgs: created.session.orgs.map(
          ({ isProvisional: _isProvisional, demoExpiresAt: _demo, ...org }) => org,
        ),
      }),
    );

    await expect(loadSessionFromCookieHeader(kv.namespace(), created.cookie, NOW)).resolves.toEqual(
      {
        ok: false,
        reason: "invalid",
      },
    );
  });

  // The v1 twin above only reads as a fix if the v2 path is known to refuse the
  // same value. Untested, the v2 check could be deleted and nothing goes red.
  it("refuses a v2 session carrying a non-boolean orgsTruncated", async () => {
    const kv = new MemoryKv();
    const created = await createSession(kv.namespace(), sessionPrincipal(), NOW);
    kv.store.set(
      sessionKey(created.tokenHash),
      JSON.stringify({ ...created.session, orgsTruncated: "definitely" }),
    );

    await expect(loadSessionFromCookieHeader(kv.namespace(), created.cookie, NOW)).resolves.toEqual(
      {
        ok: false,
        reason: "invalid",
      },
    );
  });
});
