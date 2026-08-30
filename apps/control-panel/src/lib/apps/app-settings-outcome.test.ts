import { describe, expect, it } from "vitest";
import { settleAppMutation } from "#lib/apps/app-settings-outcome";

/**
 * Renaming or deleting an App changes what the session says about itself, so the
 * mutation is followed by a session resync. The three outcomes have to stay
 * distinguishable (SPL-203): a resync failure means the App WAS renamed and the
 * session is stale, which is nothing like a refused rename.
 */
describe("settleAppMutation", () => {
  const ok = { ok: true, status: 200, data: { id: "app_1", key: "renamed" } } as const;

  it("reports a clean mutation with a healthy session", async () => {
    const settled = await settleAppMutation(ok, async () => {});

    expect(settled).toEqual({ ...ok, sessionResync: { ok: true } });
  });

  it("keeps a refusal a refusal, and never resyncs behind it", async () => {
    let resyncs = 0;
    const refused = {
      ok: false,
      status: 403,
      error: { code: "FORBIDDEN", message: "not allowed", details: {} },
    } as const;

    const settled = await settleAppMutation(refused, async () => {
      resyncs += 1;
    });

    expect(settled).toBe(refused);
    expect(resyncs).toBe(0);
  });

  it("still reports success when the session could not be refreshed, and says why", async () => {
    const settled = await settleAppMutation(ok, async () => {
      throw new Error("D1 is unreachable");
    });

    expect(settled.ok).toBe(true);
    expect(settled.ok && settled.sessionResync).toEqual({
      ok: false,
      reason: "D1 is unreachable",
      remedy: "retry",
    });
  });

  it("offers re-authentication only for the failures signing in again repairs", async () => {
    const settled = await settleAppMutation(ok, async () => {
      throw Object.assign(new Error("session expired"), { remedy: "reauth" });
    });

    expect(settled.ok && settled.sessionResync).toEqual({
      ok: false,
      reason: "session expired",
      remedy: "reauth",
    });
  });
});
