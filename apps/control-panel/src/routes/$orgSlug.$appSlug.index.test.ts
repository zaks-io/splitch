import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  isNotFound,
  isRedirect,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setControlPanelSentryClientForTests } from "#lib/observability/panel-observability";
import { AccessDeniedError } from "#lib/shared/loader-context";

const loadAppScopedSessionMock = vi.fn();
const loadControlPanelFlagsMatrixMock = vi.fn();

vi.mock("#lib/sessions/session-functions", () => ({
  loadAppScopedSession: (...args: unknown[]) => loadAppScopedSessionMock(...args),
}));
vi.mock("#lib/flags/control-plane-flag-functions", () => ({
  loadControlPanelFlagsMatrix: (...args: unknown[]) => loadControlPanelFlagsMatrixMock(...args),
}));
vi.mock("#components/flags/flags-matrix-page", () => ({ FlagsMatrixPage: () => null }));
vi.mock("#components/shell/command-palette", () => ({ CommandPalette: () => null }));
// The sidebar's Create Organization dialog reaches the create server function.
vi.mock("#lib/organizations/control-plane-organization-functions", () => ({
  createControlPanelOrganization: vi.fn(),
}));

const { Route } = await import("./$orgSlug.$appSlug.index");
const params = { appSlug: "checkout-api", orgSlug: "acme-labs" };

// TanStack's loader type union has no common call signature outside the framework.
// biome-ignore lint/suspicious/noExplicitAny: the fixture supplies the loader fields this route reads
const loader = Route.options.loader as any;

function runLoader() {
  return loader({
    location: {
      href: "https://panel.splitch.dev/acme-labs/checkout-api",
      pathname: "/acme-labs/checkout-api",
    },
    params,
  });
}

describe("$orgSlug/$appSlug loader", () => {
  afterEach(() => setControlPanelSentryClientForTests(undefined));

  beforeEach(() => {
    loadAppScopedSessionMock.mockReset();
    loadControlPanelFlagsMatrixMock.mockReset();
  });

  it("redirects unauthenticated requests to login", async () => {
    loadAppScopedSessionMock.mockResolvedValue({ kind: "unauthenticated" });
    await expect(runLoader()).rejects.toSatisfy(isRedirect);
    expect(loadControlPanelFlagsMatrixMock).not.toHaveBeenCalled();
  });

  it.each([new Error("matrix failed"), new AccessDeniedError()])(
    "preserves %s through the router error callback",
    async (error) => {
      const captureException = vi.fn();
      const addBreadcrumb = vi.fn();
      setControlPanelSentryClientForTests({ captureException, addBreadcrumb });
      loadAppScopedSessionMock.mockRejectedValue(error);
      const root = createRootRoute();
      const route = createRoute({
        getParentRoute: () => root,
        path: "/$orgSlug/$appSlug/",
        loader: runLoader,
        onError: Route.options.onError,
      });
      const router = createRouter({
        routeTree: root.addChildren([route]),
        history: createMemoryHistory({ initialEntries: ["/acme-labs/checkout-api"] }),
      });

      await router.load();

      if (error instanceof AccessDeniedError) {
        expect(captureException).not.toHaveBeenCalled();
        expect(addBreadcrumb).toHaveBeenCalledWith(
          expect.objectContaining({ level: "info", message: "403 /$orgSlug/$appSlug/" }),
        );
      } else {
        expect(captureException).toHaveBeenCalledWith(
          error,
          expect.objectContaining({ tags: { boundary: "section", route: "/$orgSlug/$appSlug/" } }),
        );
      }
    },
  );

  it("maps forbidden requests to AccessDeniedError", async () => {
    loadAppScopedSessionMock.mockResolvedValue({ kind: "forbidden" });
    await expect(runLoader()).rejects.toBeInstanceOf(AccessDeniedError);
    expect(loadControlPanelFlagsMatrixMock).not.toHaveBeenCalled();
  });

  it("maps missing Apps or Environments to not found", async () => {
    loadAppScopedSessionMock.mockResolvedValue({ kind: "notFound" });
    await expect(runLoader()).rejects.toSatisfy(isNotFound);
    expect(loadControlPanelFlagsMatrixMock).not.toHaveBeenCalled();
  });

  it("reads the matrix for every resolved Environment", async () => {
    loadAppScopedSessionMock.mockResolvedValue({
      kind: "ok",
      context: {
        scope: {
          appId: "app_1",
          appRole: "member",
          orgId: "org_1",
          environments: [
            { environmentId: "env_dev", env: "dev" },
            { environmentId: "env_prod", env: "prod" },
          ],
        },
        session: { userId: "user_1" },
        navigation: { orgs: [] },
      },
    });
    loadControlPanelFlagsMatrixMock.mockResolvedValue({
      ok: true,
      data: { rows: [], readLimit: 200, readTruncated: false },
    });

    await expect(runLoader()).resolves.toMatchObject({ matrix: { rows: [] } });
    expect(loadAppScopedSessionMock).toHaveBeenCalledOnce();
    expect(loadAppScopedSessionMock).toHaveBeenCalledWith({
      data: {
        appSlug: "checkout-api",
        orgSlug: "acme-labs",
        visitPath: "/acme-labs/checkout-api",
      },
    });
    expect(loadControlPanelFlagsMatrixMock).toHaveBeenCalledWith({
      data: { appId: "app_1", environmentIds: ["env_dev", "env_prod"] },
    });
  });
});
