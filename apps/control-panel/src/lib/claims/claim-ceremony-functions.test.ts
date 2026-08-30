import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const { claimSessionAfterRefresh } = await import("#lib/claims/claim-ceremony-functions");

describe("claim session refresh", () => {
  it("preserves every server-only WorkOS field while replacing memberships", () => {
    const refreshed = claimSessionAfterRefresh(
      {
        tokenHash: "token_hash",
        userId: "user_1",
        orgId: "org_1",
        expiresAt: 2_000_000_000,
        workosSessionId: "workos_session_1",
        workosAccessToken: "access_token_1",
        workosRefreshToken: "refresh_token_1",
        workosAccessTokenExpiresAt: 1_999_999_000,
      },
      {
        userId: "user_1",
        workosSessionId: "workos_session_1",
        orgs: [
          {
            orgId: "org_1",
            orgSlug: "acme",
            orgRole: "owner",
            isProvisional: false,
            demoExpiresAt: null,
            apps: [],
          },
        ],
      },
    );

    expect(refreshed).toMatchObject({
      workosSessionId: "workos_session_1",
      workosAccessToken: "access_token_1",
      workosRefreshToken: "refresh_token_1",
      workosAccessTokenExpiresAt: 1_999_999_000,
    });
  });
});
