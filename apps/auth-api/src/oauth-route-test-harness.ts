import type { PerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import { Hono } from "hono";
import type { DeviceFlowPort } from "./device-flow";
import { sealDeviceGrant } from "./device-grant";
import type { DeviceRefreshSessionStore } from "./device-session-store";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { mountOAuthRoutes } from "./oauth-routes";
import { makeRateLimiter } from "./rate-limit";
import type { RateLimiter } from "./rate-limit";
import type { RevocationStore } from "./revocation";
import { memoryKvNamespace } from "./test-kv";
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
    getOrg: async () => null,
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
  selectedAppSelector: string | null,
): Promise<string> {
  return sealDeviceGrant(
    { deviceCode, selectedAppSelector, expiresAt: 1_780_000_300_000 },
    "test-access-secret",
  );
}

export function routeApp(params: {
  spans?: PerformanceSpanRecorder;
  deviceFlow: DeviceFlowPort;
  deviceRefreshSessions: DeviceRefreshSessionStore;
  sessionStore?: KVNamespace;
  repo?: MembershipAuthorityRepo;
  tokenSigner?: TokenSigner;
  deviceAuthorizationRateLimiter?: RateLimiter;
  revocations?: RevocationStore;
}): Hono {
  const app = new Hono();
  mountOAuthRoutes(app, {
    spans: params.spans,
    tokenSigner: params.tokenSigner ?? tokenSigner,
    deviceFlow: params.deviceFlow,
    deviceRefreshSessions: params.deviceRefreshSessions,
    sessionStore: params.sessionStore ?? memoryKvNamespace(),
    revocations: params.revocations ?? revocations,
    accessSecret: "test-access-secret",
    issuer: "http://localhost",
    controlPlaneAudience: "https://cp.splitch.test",
    now: () => 1_780_000_000_000,
    repo: params.repo ?? emptyMembershipRepo,
    deviceAuthorizationRateLimiter: params.deviceAuthorizationRateLimiter ?? makeRateLimiter(),
  });
  return app;
}
