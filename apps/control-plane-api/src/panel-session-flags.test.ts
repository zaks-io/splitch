import { describe, expect, it, vi } from "vitest";
import { makeControlPlaneAuthResolver, PANEL_SESSION_HEADER } from "./auth-resolver";
import type { JwksVerifier } from "./jwks-verify";
import type { PanelSessionAccess } from "./panel-session-access";
import type { SessionStore } from "./session-store";

const SESSION_HASH = "a".repeat(64);
const SESSION_ACTOR = { userId: "user_1" };

describe("Control Panel Flags principal", () => {
  it("derives least-privilege scopes from live App access", async () => {
    const authorizeApp = vi.fn<PanelSessionAccess["authorizeApp"]>(async () => ({
      appId: "app_1",
      appRole: "admin",
      orgId: "org_1",
      orgRole: "member",
    }));
    const resolver = makeResolver({ authorizeApp });

    const result = await resolver(panelRequest("GET", "/apps/app_1/flags"));

    expect(result).toEqual({
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: "user_1",
        scopes: ["org:org_1:member", "app:app_1:admin"],
        orgId: "org_1",
        appId: "app_1",
        environmentId: null,
      },
    });
    expect(authorizeApp).toHaveBeenCalledWith("user_1", "app_1", "env_1");
  });

  it("binds a Configuration read to the requested Environment", async () => {
    const authorizeApp = vi.fn<PanelSessionAccess["authorizeApp"]>(async () => null);
    const resolver = makeResolver({ authorizeApp });

    const result = await resolver(
      panelRequest("GET", "/apps/app_1/envs/env_1/flags/flag_1/config"),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(authorizeApp).toHaveBeenCalledWith("user_1", "app_1", "env_1");
  });

  it("does not redeem a panel session outside the named entrypoint mode", async () => {
    const verify = vi.fn(async () => null);
    const resolver = makeControlPlaneAuthResolver(deps(verify));

    const result = await resolver(panelRequest("GET", "/apps/app_1/flags"));

    expect(result).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("never falls back to the panel session when Authorization is present", async () => {
    const authorizeApp = vi.fn<PanelSessionAccess["authorizeApp"]>(async () => null);
    const resolver = makeResolver({ authorizeApp });
    const request = panelRequest("GET", "/apps/app_1/flags");
    request.headers.set("authorization", "Bearer invalid");

    const result = await resolver(request);

    expect(result).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(authorizeApp).not.toHaveBeenCalled();
  });
});

function makeResolver(panelAccess: PanelSessionAccess) {
  return makeControlPlaneAuthResolver(deps(), { allowPanelSession: true, panelAccess });
}

function deps(verify = async () => null) {
  return {
    verifier: { verify } as unknown as JwksVerifier,
    sessions: {
      loadPanelSessionActor: async () => SESSION_ACTOR,
      isRevoked: async () => false,
    } as unknown as SessionStore,
    now: () => 0,
  };
}

function panelRequest(method: string, path: string): Request {
  return new Request(`https://control-plane.internal${path}`, {
    method,
    headers: {
      [PANEL_SESSION_HEADER]: SESSION_HASH,
      "x-splitch-panel-environment": "env_1",
    },
  });
}
