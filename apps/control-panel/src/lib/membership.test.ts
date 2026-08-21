import type { Repository } from "@splitch/db";
import { describe, expect, it } from "vitest";
import {
  buildSessionPrincipal,
  createEnvironmentResolver,
  rehydrateLegacySession,
  SESSION_ORG_LIMIT,
} from "./membership";
import type { StoredSession } from "./session";

describe("session membership materialization", () => {
  it("materializes Organization and App memberships without an Environment default", async () => {
    const principal = await buildSessionPrincipal(repository(), {
      userId: "user_1",
      workosSessionId: "workos_session_1",
    });

    expect(principal).toEqual({
      userId: "user_1",
      workosSessionId: "workos_session_1",
      orgsTruncated: false,
      orgs: [
        {
          orgId: "org_1",
          orgRole: "admin",
          orgSlug: "acme-inc",
          isProvisional: false,
          demoExpiresAt: null,
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

  // The lockout defect. The previous shape issued 2N+1 SEQUENTIAL D1 queries per
  // rebuild, so a User creating Organizations in a loop drove their own session
  // rebuild past the Workers subrequest ceiling and could never sign in again.
  it("costs the same number of queries at one Organization as at the cap", async () => {
    const counts: Array<{ orgs: number; queries: number }> = [];
    for (const orgs of [1, 5, SESSION_ORG_LIMIT]) {
      const repo = repository({ orgCount: orgs, appsPerOrg: 3 });
      await buildSessionPrincipal(repo, { userId: "user_1", workosSessionId: "workos_session_1" });
      counts.push({ orgs, queries: queryCounts.get(repo) ?? -1 });
    }

    expect(counts).toEqual([
      { orgs: 1, queries: 2 },
      { orgs: 5, queries: 2 },
      { orgs: SESSION_ORG_LIMIT, queries: 2 },
    ]);
  });

  it("keeps every App on its own Organization when several are materialized at once", async () => {
    const principal = await buildSessionPrincipal(repository({ orgCount: 3, appsPerOrg: 2 }), {
      userId: "user_1",
      workosSessionId: "workos_session_1",
    });

    expect(principal.orgs.map((org) => org.apps.map((app) => app.appId))).toEqual([
      ["org_1_app_1", "org_1_app_2"],
      ["org_2_app_1", "org_2_app_2"],
      ["org_3_app_1", "org_3_app_2"],
    ]);
  });

  it("caps the snapshot and says so rather than serving a short list as complete", async () => {
    const principal = await buildSessionPrincipal(
      repository({ orgCount: SESSION_ORG_LIMIT + 25, appsPerOrg: 0 }),
      { userId: "user_1", workosSessionId: "workos_session_1" },
    );

    expect(principal.orgs).toHaveLength(SESSION_ORG_LIMIT);
    expect(principal.orgsTruncated).toBe(true);
  });

  it("does not claim truncation when the membership count is exactly the cap", async () => {
    const principal = await buildSessionPrincipal(
      repository({ orgCount: SESSION_ORG_LIMIT, appsPerOrg: 0 }),
      { userId: "user_1", workosSessionId: "workos_session_1" },
    );

    expect(principal.orgs).toHaveLength(SESSION_ORG_LIMIT);
    expect(principal.orgsTruncated).toBe(false);
  });

  it("rehydrates a v1 session from D1 and writes the current version back to KV", async () => {
    const kv = new MemoryKv();
    const session: StoredSession = {
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      orgs: [
        {
          apps: [],
          demoExpiresAt: null,
          isProvisional: false,
          orgId: "org_stale",
          orgRole: "member",
          orgSlug: "stale",
        },
      ],
      userId: "user_1",
      version: 1,
      workosAccessToken: "workos-access-token",
      workosRefreshToken: "workos-refresh-token",
      workosAccessTokenExpiresAt: Math.floor(Date.now() / 1000) + 60,
      workosSessionId: "workos_session_1",
    };

    const rehydrated = await rehydrateLegacySession(repository(), kv.namespace(), "token", session);

    expect(rehydrated).toMatchObject({
      version: 2,
      workosAccessToken: "workos-access-token",
      workosRefreshToken: "workos-refresh-token",
      workosAccessTokenExpiresAt: session.workosAccessTokenExpiresAt,
      orgs: [expect.objectContaining({ orgId: "org_1", orgSlug: "acme-inc" })],
    });
    expect(JSON.parse(kv.store.get("session:token") ?? "null")).toMatchObject({
      version: 2,
      workosAccessToken: "workos-access-token",
      workosRefreshToken: "workos-refresh-token",
      workosAccessTokenExpiresAt: session.workosAccessTokenExpiresAt,
    });
  });
});

describe("Environment navigation policy", () => {
  it("marks an all-allow Environment as unguarded", async () => {
    const [environment] = await createEnvironmentResolver(
      environmentRepository(policyJson("allow")),
    ).listEnvironments("app_1");

    expect(environment).toMatchObject({ env: "dev", guarded: false });
  });

  it("marks an Environment guarded when any change type confirms", async () => {
    const [environment] = await createEnvironmentResolver(
      environmentRepository(policyJson("confirm")),
    ).listEnvironments("app_1");

    expect(environment).toMatchObject({ env: "dev", guarded: true });
  });

  it("fails loud when persisted Environment Policy is unparsable", async () => {
    await expect(
      createEnvironmentResolver(environmentRepository('{"enabledState":"allow"}')).listEnvironments(
        "app_1",
      ),
    ).rejects.toThrow();
  });
});

interface RepositoryOptions {
  duplicateOrgSlug?: boolean;
  orgMissing?: boolean;
  orgCount?: number;
  appsPerOrg?: number;
}

const queryCounts = new WeakMap<Repository, number>();

function policyJson(enabledState: "allow" | "confirm"): string {
  return JSON.stringify({
    variantAvailability: "allow",
    targetingRolloutValue: "allow",
    enabledState,
    startExperimentRun: "allow",
  });
}

function environmentRepository(policy: string): Repository {
  return {
    identity: {
      listEnvironments: async () => [
        {
          id: "env_1",
          appId: "app_1",
          key: "dev",
          name: "Development",
          policy,
          createdAt: "2026-08-21T00:00:00.000Z",
          updatedAt: "2026-08-21T00:00:00.000Z",
          createdBy: "user_1",
        },
      ],
    },
  } as unknown as Repository;
}

function repository(options: RepositoryOptions = {}): Repository {
  const orgCount = options.duplicateOrgSlug ? 2 : (options.orgCount ?? 1);
  const appsPerOrg = options.appsPerOrg ?? 1;
  const createdAt = "2026-07-05T12:00:00.000Z";

  const orgRows = Array.from({ length: orgCount }, (_, index) => ({
    role: index === 0 ? "admin" : "member",
    org: options.orgMissing
      ? null
      : {
          createdAt,
          demoExpiresAt: null,
          id: `org_${index + 1}`,
          isProvisional: false,
          name: `Org ${index + 1}`,
          // A fixed handle forces the `duplicateOrgSlug` collision that the
          // unique index makes impossible in real D1, proving the loader still
          // refuses if that invariant ever breaks.
          slug: options.duplicateOrgSlug ? "acme-inc" : orgSlugFor(index, orgCount),
          plan: "free",
          updatedAt: createdAt,
        },
  }));

  const appRows = orgRows.flatMap((row, orgIndex) =>
    Array.from({ length: appsPerOrg }, (_, appIndex) => ({
      role: "viewer",
      app: {
        createdAt,
        description: null,
        id: appIdFor(orgIndex, appIndex, orgCount),
        key: appKeyFor(orgIndex, appIndex, orgCount),
        name: "App",
        organizationId: row.org?.id ?? "org_missing",
        updatedAt: createdAt,
      },
    })),
  );

  const repo = {
    identity: {
      listOrgMembershipsWithOrgForUser: async (_userId: string, limit: number) => {
        queryCounts.set(repo, (queryCounts.get(repo) ?? 0) + 1);
        return orgRows.slice(0, limit);
      },
      listAppMembershipsWithAppForUser: async (_userId: string, orgIds: readonly string[]) => {
        queryCounts.set(repo, (queryCounts.get(repo) ?? 0) + 1);
        const wanted = new Set(orgIds);
        return appRows.filter((row) => wanted.has(row.app.organizationId));
      },
    },
  } as unknown as Repository;

  return repo;
}

/** Single-Org fixtures keep the historical names the other assertions pin. */
function orgSlugFor(index: number, orgCount: number): string {
  return orgCount === 1 ? "acme-inc" : `org-${index + 1}`;
}

function appIdFor(orgIndex: number, appIndex: number, orgCount: number): string {
  return orgCount === 1 && appIndex === 0 ? "app_1" : `org_${orgIndex + 1}_app_${appIndex + 1}`;
}

function appKeyFor(orgIndex: number, appIndex: number, orgCount: number): string {
  return orgCount === 1 && appIndex === 0
    ? "checkout-api"
    : `org-${orgIndex + 1}-app-${appIndex + 1}`;
}

class MemoryKv {
  readonly store = new Map<string, string>();

  namespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}
