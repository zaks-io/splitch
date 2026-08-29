import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
  parseControlPanelOperation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { describe, expect, it, vi } from "vitest";
import { makeControlPlaneAuthResolver, PANEL_SESSION_HEADER } from "./auth-resolver";
import type { JwksVerifier } from "./jwks-verify";
import type { PanelDelegationReplayStore } from "./panel-identity-replay";
import type { PanelSessionAccess } from "./panel-session-access";
import type { PanelSessionStore, SessionStore } from "./session-store";

const NOW = 1_800_000_000;
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

describe("Control Panel Flags principal", () => {
  it("derives least-privilege scopes from live App access", async () => {
    const authorizeApp = vi.fn<PanelSessionAccess["authorizeApp"]>(async () => ({
      appId: "app_1",
      appRole: "admin",
      orgId: "org_1",
      orgRole: "member",
    }));
    const resolver = makeResolver({ authorizeApp });

    const result = await resolver(await panelRequest("GET", "/apps/app_1/flags"));

    expect(result).toEqual({
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: "user_1",
        scopes: ["org:org_1:member", "app:app_1:admin"],
        orgId: "org_1",
        appId: "app_1",
        environmentId: null,
        // A Panel session only exists behind a completed WorkOS sign-in.
        authDoor: "id_jag",
      },
    });
    expect(authorizeApp).toHaveBeenCalledWith("user_1", "app_1", "env_1");
  });

  it("binds a Configuration read to the requested Environment", async () => {
    const authorizeApp = vi.fn<PanelSessionAccess["authorizeApp"]>(async () => null);
    const resolver = makeResolver({ authorizeApp });

    const result = await resolver(
      await panelRequest("GET", "/apps/app_1/envs/env_1/flags/flag_1/config"),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(authorizeApp).toHaveBeenCalledWith("user_1", "app_1", "env_1");
  });

  it("binds an attention-rollup read to live App access without an Environment claim", async () => {
    const authorizeApp = vi.fn<PanelSessionAccess["authorizeApp"]>(async () => ({
      appId: "app_1",
      appRole: "member",
      orgId: "org_1",
      orgRole: "member",
    }));
    const resolver = makeResolver({ authorizeApp });

    const result = await resolver(await panelRequest("GET", "/apps/app_1/attention-rollup"));

    expect(result).toMatchObject({
      ok: true,
      principal: { id: "user_1", orgId: "org_1", appId: "app_1" },
    });
    expect(authorizeApp).toHaveBeenCalledWith("user_1", "app_1", undefined);
  });

  it("does not redeem a panel delegation outside the named entrypoint mode", async () => {
    const verify = vi.fn(async () => null);
    const resolver = makeControlPlaneAuthResolver(deps(verify));

    const result = await resolver(await panelRequest("GET", "/apps/app_1/flags"));

    expect(result).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("never falls back to the panel delegation when Authorization is present", async () => {
    const authorizeApp = vi.fn<PanelSessionAccess["authorizeApp"]>(async () => null);
    const resolver = makeResolver({ authorizeApp });
    const request = await panelRequest("GET", "/apps/app_1/flags");
    request.headers.set("authorization", "Bearer invalid");

    const result = await resolver(request);

    expect(result).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(authorizeApp).not.toHaveBeenCalled();
  });

  it("does not broaden the bounded predecessor session protocol to Flags", async () => {
    const loadPanelSessionActor = vi.fn(async () => ({ userId: "user_1" }));
    const resolver = makeControlPlaneAuthResolver(deps(), {
      allowBoundedPanelSession: true,
      boundedPanelSessions: { loadPanelSessionActor } as PanelSessionStore,
    });
    const request = new Request("https://control-plane.internal/apps/app_1/flags", {
      headers: {
        "x-splitch-panel-environment": "env_1",
        [PANEL_SESSION_HEADER]: "a".repeat(64),
      },
    });

    const result = await resolver(request);

    expect(result).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(loadPanelSessionActor).not.toHaveBeenCalled();
  });
});

function makeResolver(panelAccess: PanelSessionAccess) {
  return makeControlPlaneAuthResolver(deps(), {
    allowPanelDelegation: true,
    panelDelegationSecret: DELEGATION_SECRET,
    panelAccess,
    panelDelegationReplay: { consume: async () => true } as PanelDelegationReplayStore,
  });
}

function deps(verify = async () => null) {
  return {
    verifier: { verify } as unknown as JwksVerifier,
    sessions: {
      isRevoked: async () => false,
    } as SessionStore,
    membershipAccess: {
      authorize: async () => true,
      resolve: async () => {
        throw new Error("test fixture has no wide membership resolver");
      },
    },
    now: () => NOW * 1000,
  };
}

async function panelRequest(method: string, path: string): Promise<Request> {
  const request = new Request(`https://control-plane.internal${path}`, {
    method,
    headers: { "x-splitch-panel-environment": "env_1" },
  });
  const url = new URL(request.url);
  const operation = parseControlPanelOperation(method, url.pathname, "env_1", url.searchParams);
  if (!operation) throw new Error(`expected a Control Panel operation for ${method} ${path}`);
  request.headers.set(
    CONTROL_PANEL_DELEGATION_HEADER,
    await issueControlPanelDelegation(request, operation, "user_1", DELEGATION_SECRET, {
      nowSeconds: NOW,
      sessionExpiresAt: NOW + 30,
      nonce: `nonce_${method.toLowerCase()}_1234567890`,
    }),
  );
  return request;
}
