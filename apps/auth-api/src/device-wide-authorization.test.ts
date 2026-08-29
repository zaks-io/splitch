import { describe, expect, it, vi } from "vitest";
import type { DeviceFlowPort } from "./device-flow";
import type { DeviceRefreshSession } from "./device-session-store";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { form, routeApp, tokenSigner } from "./oauth-route-test-harness";

const SELECTED_APP = "app_selected";
const stored: DeviceRefreshSession = {
  providerSessionId: "session_selected",
  userId: "user_device",
  providerOrganizationId: "org_selected",
  selectedAppSelector: SELECTED_APP,
};

describe("membership-wide refresh authorization", () => {
  it("refuses a wide grant when the device session has an App selection", async () => {
    const refreshProviderToken = vi.fn();
    const mintAccessToken = vi.fn();
    const app = routeApp({
      tokenSigner: { ...tokenSigner, mintAccessToken },
      repo: membershipRepo(),
      deviceFlow: deviceFlow(refreshProviderToken),
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () => stored,
        rotate: async () => {},
        forget: async () => {},
      },
    });

    const response = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: "splitch-cli",
        refresh_token: "refresh_selected",
        authorization: "membership-wide-read",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description:
        "membership-wide read authorization cannot be combined with an App selection",
    });
    expect(refreshProviderToken).not.toHaveBeenCalled();
    expect(mintAccessToken).not.toHaveBeenCalled();
  });
});

function membershipRepo(): MembershipAuthorityRepo {
  return {
    identity: {
      listOrgMembershipsForUser: async () => [{ orgId: "org_selected", role: "owner" }],
      listAppsForOrg: async () => [{ id: SELECTED_APP, key: "selected-app" }],
      getAppMembership: async () => ({ role: "member" }),
      getOrg: async () => ({ id: "org_selected", slug: "selected-org" }),
    },
  } as unknown as MembershipAuthorityRepo;
}

function deviceFlow(refreshProviderToken: ReturnType<typeof vi.fn>): DeviceFlowPort {
  return {
    authorizeDevice: async () => {
      throw new Error("not used");
    },
    exchangeDeviceCode: async () => {
      throw new Error("not used");
    },
    refreshProviderToken,
    revokeProviderToken: async () => {
      throw new Error("not used");
    },
  } as unknown as DeviceFlowPort;
}
