import { describe, expect, it } from "vitest";
import { resyncRemedy } from "#lib/live-updates/resync-remedy";

/** Mirrors `session.ts`'s `RemediableSessionError` without importing it (that would pull `@splitch/db` in). */
class FakeRemediableSessionError extends Error {
  readonly remedy = "reauth" as const;
}

describe("resyncRemedy", () => {
  it("classifies a RemediableSessionError-shaped throw as reauth-fixable", () => {
    expect(resyncRemedy(new FakeRemediableSessionError("missing workosSessionId"))).toBe("reauth");
  });

  // The review's blocker: everything that is not explicitly tagged reauth
  // defaults to retry, because claiming re-auth works when it does not is the
  // impossible-remedy shape this ticket exists to remove. A D1 outage, a KV
  // outage, and every deterministic membership-materialization invariant
  // break (unknown role, duplicate handle, missing Organization) all land here.
  it("defaults an ordinary Error to retry", () => {
    expect(resyncRemedy(new Error("unknown App role in session materialization"))).toBe("retry");
  });

  it("defaults a non-Error throw to retry", () => {
    expect(resyncRemedy("session store unavailable")).toBe("retry");
  });

  it("does not trust a plain object that merely carries a remedy-shaped field", () => {
    // Only a real Error (or subclass) counts — an attacker- or bug-supplied
    // plain object claiming `remedy: "reauth"` must not short-circuit this.
    expect(resyncRemedy({ message: "spoofed", remedy: "reauth" })).toBe("retry");
  });
});
