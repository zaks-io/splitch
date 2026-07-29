import { describe, expect, it, vi } from "vitest";
import { makeControlPlaneAuthResolver, PANEL_SESSION_HEADER } from "./auth-resolver";
import type { JwksVerifier } from "./jwks-verify";
import { makePanelSessionStore, type PanelSessionStore } from "./session-store";

const NOW = 1_800_000_000;
const TOKEN_HASH = "a".repeat(64);

describe("bounded predecessor Panel session protocol", () => {
  it("redeems the exact origin/main apps_create request shape", async () => {
    const loadPanelSessionActor = vi.fn(async () => ({ userId: "user_1" }));
    const resolver = makeResolver({ loadPanelSessionActor });

    const result = await resolver(basePanelRequest());

    expect(result).toEqual({
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: "user_1",
        scopes: ["org:org_1:owner"],
        orgId: "org_1",
        appId: null,
        environmentId: null,
        // A Panel session only exists behind a completed WorkOS sign-in.
        authDoor: "id_jag",
      },
    });
    expect(loadPanelSessionActor).toHaveBeenCalledWith(TOKEN_HASH, NOW);
  });

  it("does not redeem the handle when bounded mode is absent", async () => {
    const loadPanelSessionActor = vi.fn(async () => ({ userId: "user_1" }));
    const resolver = makeControlPlaneAuthResolver(deps(), {
      boundedPanelSessions: { loadPanelSessionActor },
    });

    expect(await resolver(basePanelRequest())).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(loadPanelSessionActor).not.toHaveBeenCalled();
  });

  it("fails closed when live session redemption refuses the handle", async () => {
    const loadPanelSessionActor = vi.fn(async () => null);
    const resolver = makeResolver({ loadPanelSessionActor });

    expect(await resolver(basePanelRequest())).toEqual({ ok: false, reason: "UNAUTHORIZED" });
  });

  it("never falls back to the session handle when bearer material is present", async () => {
    const loadPanelSessionActor = vi.fn(async () => ({ userId: "user_1" }));
    const resolver = makeResolver({ loadPanelSessionActor });
    const request = basePanelRequest();
    request.headers.set("authorization", "Bearer invalid");

    expect(await resolver(request)).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(loadPanelSessionActor).not.toHaveBeenCalled();
  });

  it("redeems only a live stored session at the SHA-256 handle key", async () => {
    const get = vi.fn(async () =>
      JSON.stringify({ version: 2, userId: "user_1", orgs: [], expiresAt: NOW + 1 }),
    );
    const sessions = makePanelSessionStore({ get } as unknown as KVNamespace);

    await expect(sessions.loadPanelSessionActor(TOKEN_HASH, NOW)).resolves.toEqual({
      userId: "user_1",
    });
    expect(get).toHaveBeenCalledWith(`session:${TOKEN_HASH}`, "text");
  });

  it("rejects malformed handles and expired stored sessions", async () => {
    const get = vi.fn(async () =>
      JSON.stringify({ version: 2, userId: "user_1", orgs: [], expiresAt: NOW }),
    );
    const sessions = makePanelSessionStore({ get } as unknown as KVNamespace);

    await expect(sessions.loadPanelSessionActor("not-a-hash", NOW)).resolves.toBeNull();
    await expect(sessions.loadPanelSessionActor(TOKEN_HASH, NOW)).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });
});

function makeResolver(sessionOverrides: Partial<PanelSessionStore>) {
  return makeControlPlaneAuthResolver(deps(), {
    allowBoundedPanelSession: true,
    boundedPanelSessions: {
      loadPanelSessionActor: async () => null,
      ...sessionOverrides,
    },
  });
}

function deps() {
  return {
    verifier: { verify: async () => null } as unknown as JwksVerifier,
    sessions: { isRevoked: async () => false },
    now: () => NOW * 1000,
  };
}

/** Exact request shape emitted by origin/main's panelSessionFetch predecessor. */
function basePanelRequest(): Request {
  return new Request("https://control-plane.internal/orgs/org_1/apps", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [PANEL_SESSION_HEADER]: TOKEN_HASH,
    },
    body: JSON.stringify({ organizationId: "org_1", name: "Checkout", key: "checkout" }),
  });
}
