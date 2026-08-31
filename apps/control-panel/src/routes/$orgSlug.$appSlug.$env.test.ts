import { isNotFound, isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `deferredDestinationAt` unit tests in `app-shell-navigation.test.ts`
 * prove the pure guard function works in isolation. They do not prove this
 * loader actually calls it: nothing else in the control-panel unit suite
 * imports from `routes/`, and the e2e spec that does exercise this wiring
 * runs on a schedule only, not as a blocking CI gate. This test targets the
 * enforcement point itself so removing the guard here goes red in
 * `pnpm verify:ci`, not just in a nightly run.
 */

const loadScopedSessionMock = vi.fn();
const deferredDestinationAtMock = vi.fn();
const recordLastVisitedScopeMock = vi.fn();

vi.mock("#lib/sessions/session-functions", () => ({
  loadScopedSession: (...args: unknown[]) => loadScopedSessionMock(...args),
}));
vi.mock("#lib/sessions/last-visited-scope-functions", () => ({
  recordLastVisitedScope: (...args: unknown[]) => recordLastVisitedScopeMock(...args),
}));
vi.mock("#components/shell/command-palette", () => ({ CommandPalette: () => null }));
// The sidebar's Create Organization dialog reaches the create server function.
vi.mock("#lib/organizations/control-plane-organization-functions", () => ({
  createControlPanelOrganization: vi.fn(),
}));

vi.mock("#lib/shell/app-shell-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/shell/app-shell-navigation")>();
  return {
    ...actual,
    deferredDestinationAt: (...args: unknown[]) => deferredDestinationAtMock(...args),
  };
});

const { Route } = await import("./$orgSlug.$appSlug.$env");

const params = { appSlug: "checkout-api", env: "dev", orgSlug: "acme-labs" };

const okResult = {
  context: {
    scope: { appId: "app_1", appRole: "member", orgId: "org_1" },
    session: { userId: "user_1" },
  },
  kind: "ok" as const,
};

function locationFor(pathname: string) {
  return { href: `https://panel.splitch.dev${pathname}`, pathname };
}

// TanStack's loader type union has no common call signature outside the
// framework's own invocation; this test calls it directly with a minimal
// fixture rather than the full loader context.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
const loader = Route.options.loader as any;
// biome-ignore lint/suspicious/noExplicitAny: see comment above
const beforeLoad = Route.options.beforeLoad as any;

async function runLoader(pathname: string): Promise<unknown> {
  const location = locationFor(pathname);
  const routeContext = await beforeLoad({
    context: {
      queryClient: {
        ensureQueryData: (options: { queryFn: () => Promise<unknown> }) => options.queryFn(),
      },
    },
    location,
    params,
  });
  return loader({ context: routeContext, location, params });
}

describe("$orgSlug/$appSlug/$env loader — deferred deep link enforcement", () => {
  beforeEach(() => {
    loadScopedSessionMock.mockReset();
    deferredDestinationAtMock.mockReset();
    deferredDestinationAtMock.mockReturnValue(undefined);
    recordLastVisitedScopeMock.mockReset();
    recordLastVisitedScopeMock.mockResolvedValue(undefined);
  });

  it("404s a direct request for a deferred destination once membership resolves", async () => {
    loadScopedSessionMock.mockResolvedValue(okResult);
    deferredDestinationAtMock.mockReturnValue({
      label: "Deferred",
      to: "/$orgSlug/$appSlug/$env/deferred",
      status: "deferred",
      hiddenBecause: "test fixture",
    });
    await expect(runLoader("/acme-labs/checkout-api/dev/deferred")).rejects.toSatisfy(isNotFound);
  });

  it("404s a deep link to a descendant of a deferred destination", async () => {
    loadScopedSessionMock.mockResolvedValue(okResult);
    deferredDestinationAtMock.mockReturnValue({
      label: "Deferred",
      to: "/$orgSlug/$appSlug/$env/deferred",
      status: "deferred",
      hiddenBecause: "test fixture",
    });
    await expect(runLoader("/acme-labs/checkout-api/dev/deferred/child")).rejects.toSatisfy(
      isNotFound,
    );
  });

  it("returns the session context for a shipped destination", async () => {
    loadScopedSessionMock.mockResolvedValue(okResult);
    await expect(runLoader("/acme-labs/checkout-api/dev/flags")).resolves.toBe(okResult.context);
    await expect(runLoader("/acme-labs/checkout-api/dev/segments")).resolves.toBe(okResult.context);
    expect(recordLastVisitedScopeMock).toHaveBeenLastCalledWith({
      data: {
        orgId: "org_1",
        appSlug: "checkout-api",
        env: "dev",
        path: "/acme-labs/checkout-api/dev/segments",
      },
    });
  });

  it("still redirects an unauthenticated request instead of checking deferred status", async () => {
    loadScopedSessionMock.mockResolvedValue({ kind: "unauthenticated" });
    await expect(runLoader("/acme-labs/checkout-api/dev/segments")).rejects.toSatisfy(isRedirect);
    expect(deferredDestinationAtMock).not.toHaveBeenCalled();
    expect(recordLastVisitedScopeMock).not.toHaveBeenCalled();
  });
});
