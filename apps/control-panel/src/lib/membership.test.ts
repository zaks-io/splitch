import type { Repository } from "@splitch/db";
import { describe, expect, it } from "vitest";
import { buildSessionPrincipal, organizationSlug } from "./membership";

describe("session membership materialization", () => {
  it("materializes Organization and App memberships without an Environment default", async () => {
    const principal = await buildSessionPrincipal(repository(), {
      userId: "user_1",
      workosSessionId: "workos_session_1",
    });

    expect(principal).toEqual({
      userId: "user_1",
      workosSessionId: "workos_session_1",
      orgs: [
        {
          orgId: "org_1",
          orgRole: "admin",
          orgSlug: "acme-inc",
          apps: [
            {
              appId: "app_1",
              appSlug: "checkout-api",
              role: "viewer",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(principal)).not.toContain("environmentId");
  });

  it("fails loud when membership rows reference missing Organizations", async () => {
    await expect(
      buildSessionPrincipal(repository({ orgMissing: true }), {
        userId: "user_1",
        workosSessionId: "workos_session_1",
      }),
    ).rejects.toThrow("missing Organization");
  });

  it("fails loud when two memberships derive the same Organization URL handle", async () => {
    await expect(
      buildSessionPrincipal(repository({ duplicateOrgSlug: true }), {
        userId: "user_1",
        workosSessionId: "workos_session_1",
      }),
    ).rejects.toThrow("duplicate organization URL handle");
  });
});

describe("organizationSlug", () => {
  it("normalizes names for URL scope matching", () => {
    expect(organizationSlug(" Àcme, Inc. ", "org_1")).toBe("acme-inc");
    expect(organizationSlug("   ", "org_1")).toBe("org_1");
  });
});

function repository(
  options: { duplicateOrgSlug?: boolean; orgMissing?: boolean } = {},
): Repository {
  const orgMemberships = options.duplicateOrgSlug
    ? [
        { orgId: "org_1", role: "admin", userId: "user_1" },
        { orgId: "org_2", role: "member", userId: "user_1" },
      ]
    : [{ orgId: "org_1", role: "admin", userId: "user_1" }];

  return {
    identity: {
      getAppMembership: async () => ({
        appId: "app_1",
        createdAt: "2026-07-05T12:00:00.000Z",
        role: "viewer",
        userId: "user_1",
      }),
      getOrg: async (orgId: string) => {
        if (options.orgMissing) {
          return null;
        }
        return {
          createdAt: "2026-07-05T12:00:00.000Z",
          demoExpiresAt: null,
          id: orgId,
          isProvisional: false,
          name: "Acme Inc",
          plan: "free",
          updatedAt: "2026-07-05T12:00:00.000Z",
        };
      },
      listAppsForOrg: async () => [
        {
          createdAt: "2026-07-05T12:00:00.000Z",
          description: null,
          id: "app_1",
          key: "checkout-api",
          name: "Checkout API",
          organizationId: "org_1",
          updatedAt: "2026-07-05T12:00:00.000Z",
        },
      ],
      listOrgMembershipsForUser: async () => orgMemberships,
    },
  } as unknown as Repository;
}
