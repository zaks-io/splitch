import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  type EnvironmentResolver,
  resolveScopedLoaderContext,
} from "./loader-context";
import type { SessionPrincipal } from "./session";

describe("scoped loader context", () => {
  it("resolves URL org, app, and environment through membership and D1 seams", async () => {
    const resolver = resolverFor([{ environmentId: "env_1", env: "dev", name: "Development" }]);

    const context = await resolveScopedLoaderContext(
      sessionPrincipal(),
      { orgSlug: "acme", appSlug: "checkout-api", env: "dev" },
      resolver,
    );

    expect(context.scope).toMatchObject({
      orgId: "org_1",
      appId: "app_1",
      appSlug: "checkout-api",
      environmentId: "env_1",
      env: "dev",
    });
    expect(context.navigation.orgs[0]?.apps[0]?.environments).toEqual([
      { environmentId: "env_1", env: "dev", name: "Development" },
    ]);
  });

  it("returns 403 before environment lookup when org membership does not match", async () => {
    let calls = 0;
    const resolver = resolverFor(null, () => {
      calls += 1;
    });

    await expect(
      resolveScopedLoaderContext(
        sessionPrincipal(),
        { orgSlug: "other-org", appSlug: "checkout-api", env: "dev" },
        resolver,
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(calls).toBe(0);
  });

  it("returns 403 for a stale org slug after the Organization URL handle changes", async () => {
    let calls = 0;
    const resolver = resolverFor(null, () => {
      calls += 1;
    });

    await expect(
      resolveScopedLoaderContext(
        sessionPrincipal({ orgSlug: "acme-renamed" }),
        { orgSlug: "acme", appSlug: "checkout-api", env: "dev" },
        resolver,
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(calls).toBe(0);
  });

  it("returns 404 before environment lookup when app slug is not under the org", async () => {
    let calls = 0;
    const resolver = resolverFor(null, () => {
      calls += 1;
    });

    await expect(
      resolveScopedLoaderContext(
        sessionPrincipal(),
        { orgSlug: "acme", appSlug: "billing-api", env: "dev" },
        resolver,
      ),
    ).rejects.toMatchObject({ resource: "app", status: 404 });
    expect(calls).toBe(0);
  });

  it("returns 404 only after the member App is resolved when the environment is missing", async () => {
    let calls = 0;
    const resolver = resolverFor(null, () => {
      calls += 1;
    });

    await expect(
      resolveScopedLoaderContext(
        sessionPrincipal(),
        { orgSlug: "acme", appSlug: "checkout-api", env: "prod" },
        resolver,
      ),
    ).rejects.toMatchObject({ resource: "environment", status: 404 });
    expect(calls).toBe(1);
  });
});

function resolverFor(
  result: Awaited<ReturnType<EnvironmentResolver["listEnvironments"]>> | null,
  onCall?: () => void,
): EnvironmentResolver {
  return {
    async listEnvironments() {
      onCall?.();
      return result ?? [];
    },
  };
}

function sessionPrincipal(overrides: { orgSlug?: string } = {}): SessionPrincipal {
  return {
    userId: "user_1",
    orgs: [
      {
        orgId: "org_1",
        orgRole: "member",
        orgSlug: overrides.orgSlug ?? "acme",
        isProvisional: false,
        demoExpiresAt: null,
        apps: [
          {
            appId: "app_1",
            appSlug: "checkout-api",
            role: "admin",
          },
        ],
      },
    ],
  };
}
