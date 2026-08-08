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

vi.mock("#lib/session-functions", () => ({
  loadScopedSession: (...args: unknown[]) => loadScopedSessionMock(...args),
}));

vi.mock("#lib/app-shell-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/app-shell-navigation")>();
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

async function runLoader(pathname: string): Promise<unknown> {
  return loader({ location: locationFor(pathname), params });
}

describe("$orgSlug/$appSlug/$env loader — deferred deep link enforcement", () => {
  beforeEach(() => {
    loadScopedSessionMock.mockReset();
    deferredDestinationAtMock.mockReset();
    deferredDestinationAtMock.mockReturnValue(undefined);
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
  });

  it("still redirects an unauthenticated request instead of checking deferred status", async () => {
    loadScopedSessionMock.mockResolvedValue({ kind: "unauthenticated" });
    await expect(runLoader("/acme-labs/checkout-api/dev/segments")).rejects.toSatisfy(isRedirect);
    expect(deferredDestinationAtMock).not.toHaveBeenCalled();
  });
});
