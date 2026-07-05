import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  ScopedNotFoundError,
  type EnvironmentResolver,
  resolveScopedLoaderContext,
} from "./loader-context";
import type { SessionPrincipal } from "./session";

describe("scoped loader context", () => {
  it("resolves URL org, app, and environment through membership and D1 seams", async () => {
    const resolver = resolverFor({ environmentId: "env_1", env: "dev" });

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

  it("returns 403 before environment lookup when app membership does not match", async () => {
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
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(calls).toBe(0);
  });

  it("returns 404 only after the member App is resolved", async () => {
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
    ).rejects.toBeInstanceOf(ScopedNotFoundError);
    expect(calls).toBe(1);
  });
});

function resolverFor(
  result: Awaited<ReturnType<EnvironmentResolver["findEnvironmentByKey"]>>,
  onCall?: () => void,
): EnvironmentResolver {
  return {
    async findEnvironmentByKey() {
      onCall?.();
      return result;
    },
  };
}

function sessionPrincipal(): SessionPrincipal {
  return {
    userId: "user_1",
    orgs: [
      {
        orgId: "org_1",
        orgRole: "member",
        orgSlug: "acme",
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
