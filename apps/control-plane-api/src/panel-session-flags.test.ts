import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_PANEL_IDENTITY_HEADER,
  issueControlPanelIdentity,
  serializeControlPanelIdentity,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import type { JwksVerifier } from "./jwks-verify";
import type { PanelIdentityReplayStore } from "./panel-identity-replay";
import type { PanelSessionAccess } from "./panel-session-access";
import type { SessionStore } from "./session-store";

const NOW = 1_800_000_000;

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

  it("does not redeem a panel identity outside the named entrypoint mode", async () => {
    const verify = vi.fn(async () => null);
    const resolver = makeControlPlaneAuthResolver(deps(verify));

    const result = await resolver(panelRequest("GET", "/apps/app_1/flags"));

    expect(result).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("never falls back to the panel identity when Authorization is present", async () => {
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
  return makeControlPlaneAuthResolver(deps(), {
    allowPanelIdentity: true,
    panelAccess,
    panelIdentityReplay: { consume: async () => true } as PanelIdentityReplayStore,
  });
}

function deps(verify = async () => null) {
  return {
    verifier: { verify } as unknown as JwksVerifier,
    sessions: { isRevoked: async () => false } as SessionStore,
    now: () => NOW * 1000,
  };
}

function panelRequest(method: string, path: string): Request {
  const request = new Request(`https://control-plane.internal${path}`, {
    method,
    headers: { "x-splitch-panel-environment": "env_1" },
  });
  const operation =
    path === "/apps/app_1/flags"
      ? {
          id: method === "GET" ? "flags_list" : "flags_create",
          appId: "app_1",
          environmentId: "env_1",
        }
      : { id: "flag_config_get", appId: "app_1", environmentId: "env_1" };
  request.headers.set(
    CONTROL_PANEL_IDENTITY_HEADER,
    serializeControlPanelIdentity(
      issueControlPanelIdentity(
        operation as Parameters<typeof issueControlPanelIdentity>[0],
        "user_1",
        {
          nowSeconds: NOW,
          sessionExpiresAt: NOW + 30,
          nonce: `nonce_${method.toLowerCase()}_1234567890`,
        },
      ),
    ),
  );
  return request;
}
