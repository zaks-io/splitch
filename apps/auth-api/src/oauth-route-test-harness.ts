import { Hono } from "hono";
import type { DeviceFlowPort } from "./device-flow";
import { sealDeviceGrant } from "./device-grant";
import type { DeviceRefreshSessionStore } from "./device-session-store";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { mountOAuthRoutes } from "./oauth-routes";
import type { TokenSigner } from "./token-exchange";

export const tokenSigner = {
  mintIdentityAssertion: async () => "identity-assertion",
  exchangeForAccessToken: async () => "access-token",
  verifyIdentityAssertion: async () => ({ userId: "user_workos", scopes: [] }),
  mintAccessToken: async () => "access-token",
} satisfies TokenSigner;

const revocations = {
  revoke: async () => {},
  isRevoked: async () => false,
};

const emptyMembershipRepo = {
  identity: {
    listOrgMembershipsForUser: async () => [],
    listAppsForOrg: async () => [],
    getAppMembership: async () => null,
  },
} satisfies MembershipAuthorityRepo;

export const unusedRefreshStore = {
  remember: async () => {},
  lookup: async () => null,
  rotate: async () => {},
  forget: async () => {},
} satisfies DeviceRefreshSessionStore;

export function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

export function selectedDeviceCode(
  deviceCode: string,
  selectedAppSelector: string,
  requestedRole: "owner" | "admin" | "member",
): Promise<string> {
  return sealDeviceGrant(
    { deviceCode, selectedAppSelector, requestedRole, expiresAt: 1_780_000_300_000 },
    "test-access-secret",
  );
}

export function routeApp(params: {
  deviceFlow: DeviceFlowPort;
  deviceRefreshSessions: DeviceRefreshSessionStore;
  repo?: MembershipAuthorityRepo;
  tokenSigner?: TokenSigner;
}): Hono {
  const app = new Hono();
  mountOAuthRoutes(app, {
    tokenSigner: params.tokenSigner ?? tokenSigner,
    deviceFlow: params.deviceFlow,
    deviceRefreshSessions: params.deviceRefreshSessions,
    revocations,
    accessSecret: "test-access-secret",
    controlPlaneAudience: "https://cp.splitch.test",
    now: () => 1_780_000_000_000,
    repo: params.repo ?? emptyMembershipRepo,
  });
  return app;
}
