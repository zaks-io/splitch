import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCurrentSessionMock = vi.fn();

vi.mock("#lib/sessions/session-functions", () => ({
  loadCurrentSession: (...args: unknown[]) => loadCurrentSessionMock(...args),
}));
vi.mock("#components/organizations/organization-chooser", () => ({
  OrganizationChooser: () => null,
}));

const { Route } = await import("./index");

// biome-ignore lint/suspicious/noExplicitAny: the fixture supplies the loader fields this route reads
const loader = Route.options.loader as any;

function runLoader() {
  return loader({ location: { href: "https://panel.splitch.dev/", pathname: "/" } });
}

function authenticated(overrides: Record<string, unknown> = {}) {
  return {
    kind: "authenticated",
    session: {
      userId: "user_1",
      orgs: [
        {
          orgId: "org_1",
          orgSlug: "acme labs",
          orgRole: "owner",
          isProvisional: false,
          demoExpiresAt: null,
          apps: [],
        },
      ],
      orgsTruncated: false,
    },
    pendingOrgResync: null,
    lastVisitedOrgId: null,
    ...overrides,
  };
}

function twoOrganizations(overrides: Record<string, unknown> = {}) {
  const result = authenticated(overrides);
  return {
    ...result,
    session: {
      ...result.session,
      orgs: [
        ...result.session.orgs,
        { ...result.session.orgs[0], orgId: "org_2", orgSlug: "orbit-tools" },
      ],
    },
  };
}

describe("root loader", () => {
  beforeEach(() => {
    loadCurrentSessionMock.mockReset();
  });

  it("redirects a complete one-Organization session to Home", async () => {
    loadCurrentSessionMock.mockResolvedValue(authenticated());

    await expect(runLoader()).rejects.toSatisfy(isRedirect);
    await expect(runLoader()).rejects.toMatchObject({ options: { href: "/acme%20labs" } });
  });

  it("redirects to the first Organization when nothing was visited yet", async () => {
    loadCurrentSessionMock.mockResolvedValue(twoOrganizations());

    await expect(runLoader()).rejects.toMatchObject({ options: { href: "/acme%20labs" } });
  });

  it("redirects to the last-visited Organization", async () => {
    loadCurrentSessionMock.mockResolvedValue(twoOrganizations({ lastVisitedOrgId: "org_2" }));

    await expect(runLoader()).rejects.toMatchObject({ options: { href: "/orbit-tools" } });
  });

  it("falls back to the first Organization when the last-visited one is no longer a membership", async () => {
    loadCurrentSessionMock.mockResolvedValue(twoOrganizations({ lastVisitedOrgId: "org_gone" }));

    await expect(runLoader()).rejects.toMatchObject({ options: { href: "/acme%20labs" } });
  });

  it("keeps the chooser with zero Organizations", async () => {
    const result = authenticated();
    loadCurrentSessionMock.mockResolvedValue({
      ...result,
      session: { ...result.session, orgs: [] },
    });

    await expect(runLoader()).resolves.toMatchObject({ session: { orgs: [] } });
  });

  it("keeps the chooser while Organization resync is pending", async () => {
    loadCurrentSessionMock.mockResolvedValue(
      authenticated({
        pendingOrgResync: { slug: "acme-labs", reason: "resync failed", remedy: "retry" },
      }),
    );

    await expect(runLoader()).resolves.toMatchObject({ pendingOrgResync: { slug: "acme-labs" } });
  });

  it("keeps the chooser when the Organization list is truncated", async () => {
    const result = authenticated();
    loadCurrentSessionMock.mockResolvedValue({
      ...result,
      session: { ...result.session, orgsTruncated: true },
    });

    await expect(runLoader()).resolves.toMatchObject({ session: { orgsTruncated: true } });
  });

  it("redirects an unauthenticated request to login", async () => {
    loadCurrentSessionMock.mockResolvedValue({ kind: "unauthenticated" });

    await expect(runLoader()).rejects.toSatisfy(isRedirect);
    await expect(runLoader()).rejects.toMatchObject({
      options: { href: "/auth/login?returnTo=https%3A%2F%2Fpanel.splitch.dev%2F" },
    });
  });
});
