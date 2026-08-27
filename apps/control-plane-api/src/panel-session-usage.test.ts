import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
  parseControlPanelOperation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { describe, expect, it, vi } from "vitest";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import type { JwksVerifier } from "./jwks-verify";
import type { PanelDelegationReplayStore } from "./panel-identity-replay";
import type { PanelSessionAccess } from "./panel-session-access";
import type { SessionStore } from "./session-store";

const NOW = 1_800_000_000;
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

/**
 * The Organization-wide Evaluation usage read (ADR-0033) is the first Panel
 * operation whose tenant boundary is the Org rather than an App, so these pin
 * that the boundary is enforced from live D1 membership and not from the
 * Organization id the delegation claims.
 */
describe("Control Panel Organization usage principal", () => {
  it("binds the read to the Organization the actor is a live member of", async () => {
    const authorizeOrg = vi.fn<PanelSessionAccess["authorizeOrg"]>(async () => ({
      orgId: "org_1",
      orgRole: "member",
    }));
    const resolver = makeResolver({ authorizeOrg });

    const result = await resolver(await panelRequest("/orgs/org_1/usage"));

    expect(result).toEqual({
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: "user_1",
        scopes: ["org:org_1:member"],
        orgId: "org_1",
        appId: null,
        environmentId: null,
        authDoor: "id_jag",
      },
    });
    expect(authorizeOrg).toHaveBeenCalledWith("user_1", "org_1");
  });

  it("refuses an actor with no membership in the Organization it names", async () => {
    const authorizeOrg = vi.fn<PanelSessionAccess["authorizeOrg"]>(async () => null);
    const resolver = makeResolver({ authorizeOrg });

    const result = await resolver(await panelRequest("/orgs/org_other/usage"));

    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(authorizeOrg).toHaveBeenCalledWith("user_1", "org_other");
  });

  it("refuses a delegation minted for one Organization replayed at another", async () => {
    const authorizeOrg = vi.fn<PanelSessionAccess["authorizeOrg"]>(async () => ({
      orgId: "org_1",
      orgRole: "owner",
    }));
    const resolver = makeResolver({ authorizeOrg });

    const minted = await panelRequest("/orgs/org_1/usage");
    const replayed = new Request("https://control-plane.internal/orgs/org_2/usage", {
      headers: minted.headers,
    });

    const result = await resolver(replayed);

    expect(result).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(authorizeOrg).not.toHaveBeenCalled();
  });

  it("cannot be reached without the panel delegation protocol enabled", async () => {
    const authorizeOrg = vi.fn<PanelSessionAccess["authorizeOrg"]>(async () => ({
      orgId: "org_1",
      orgRole: "owner",
    }));
    const resolver = makeControlPlaneAuthResolver(deps());

    const result = await resolver(await panelRequest("/orgs/org_1/usage"));

    expect(result).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(authorizeOrg).not.toHaveBeenCalled();
  });
});

function makeResolver(panelAccess: Pick<PanelSessionAccess, "authorizeOrg">) {
  return makeControlPlaneAuthResolver(deps(), {
    allowPanelDelegation: true,
    panelDelegationSecret: DELEGATION_SECRET,
    panelAccess: {
      authorizeApp: async () => null,
      ...panelAccess,
    },
    panelDelegationReplay: { consume: async () => true } as PanelDelegationReplayStore,
  });
}

function deps(verify = async () => null) {
  return {
    verifier: { verify } as unknown as JwksVerifier,
    sessions: { isRevoked: async () => false } as SessionStore,
    membershipAccess: { authorize: async () => true },
    now: () => NOW * 1000,
  };
}

async function panelRequest(path: string): Promise<Request> {
  const request = new Request(`https://control-plane.internal${path}`);
  const operation = parseControlPanelOperation("GET", path);
  if (!operation) throw new Error(`expected a Control Panel operation for GET ${path}`);
  request.headers.set(
    CONTROL_PANEL_DELEGATION_HEADER,
    await issueControlPanelDelegation(request, operation, "user_1", DELEGATION_SECRET, {
      nowSeconds: NOW,
      sessionExpiresAt: NOW + 30,
      nonce: "nonce_usage_1234567890",
    }),
  );
  return request;
}
