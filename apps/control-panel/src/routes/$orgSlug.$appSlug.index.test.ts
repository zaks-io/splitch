import { isNotFound, isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "#lib/shared/loader-context";

const loadAppScopedSessionMock = vi.fn();
const loadControlPanelFlagsMatrixMock = vi.fn();
const recordLastVisitedScopeMock = vi.fn();

vi.mock("#lib/sessions/session-functions", () => ({
  loadAppScopedSession: (...args: unknown[]) => loadAppScopedSessionMock(...args),
}));
vi.mock("#lib/flags/control-plane-flag-functions", () => ({
  loadControlPanelFlagsMatrix: (...args: unknown[]) => loadControlPanelFlagsMatrixMock(...args),
}));
vi.mock("#lib/sessions/last-visited-scope-functions", () => ({
  recordLastVisitedScope: (...args: unknown[]) => recordLastVisitedScopeMock(...args),
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
  beforeEach(() => {
    loadAppScopedSessionMock.mockReset();
    loadControlPanelFlagsMatrixMock.mockReset();
    recordLastVisitedScopeMock.mockReset();
    recordLastVisitedScopeMock.mockResolvedValue(undefined);
  });

  it("redirects unauthenticated requests to login", async () => {
    loadAppScopedSessionMock.mockResolvedValue({ kind: "unauthenticated" });
    await expect(runLoader()).rejects.toSatisfy(isRedirect);
    expect(loadControlPanelFlagsMatrixMock).not.toHaveBeenCalled();
  });

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
    expect(loadControlPanelFlagsMatrixMock).toHaveBeenCalledWith({
      data: { appId: "app_1", environmentIds: ["env_dev", "env_prod"] },
    });
    expect(recordLastVisitedScopeMock).toHaveBeenCalledWith({
      data: {
        orgId: "org_1",
        appSlug: "checkout-api",
        env: null,
        path: "/acme-labs/checkout-api",
      },
    });
  });

  it("does not put visit bookkeeping in front of the matrix read", async () => {
    loadAppScopedSessionMock.mockResolvedValue({
      kind: "ok",
      context: {
        scope: {
          appId: "app_1",
          appRole: "member",
          orgId: "org_1",
          environments: [{ environmentId: "env_dev", env: "dev" }],
        },
        session: { userId: "user_1" },
        navigation: { orgs: [] },
      },
    });
    const visitStarted = deferred<void>();
    const releaseVisit = deferred<void>();
    recordLastVisitedScopeMock.mockImplementation(async () => {
      visitStarted.resolve();
      await releaseVisit.promise;
    });
    loadControlPanelFlagsMatrixMock.mockResolvedValue({
      ok: true,
      data: { rows: [], readLimit: 200, readTruncated: false },
    });

    const result = runLoader();
    await visitStarted.promise;

    expect(loadControlPanelFlagsMatrixMock).toHaveBeenCalledOnce();
    releaseVisit.resolve();
    await expect(result).resolves.toMatchObject({ matrix: { rows: [] } });
  });
});

function deferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) throw new Error("deferred promise was not initialized");
  return { promise, resolve: resolvePromise };
}
