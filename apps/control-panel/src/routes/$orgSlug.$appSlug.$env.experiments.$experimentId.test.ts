import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ScopedLoaderContext } from "#lib/shared/loader-context";

const { detailQueryMock, listQueryMock, resolveMock } = vi.hoisted(() => ({
  detailQueryMock: vi.fn((input: unknown) => ({ input, kind: "detail" })),
  listQueryMock: vi.fn(() => {
    throw new Error("unrelated Analysis 500");
  }),
  resolveMock: vi.fn(),
}));

vi.mock("#lib/experiments/experiment-environment-resolution-functions", () => ({
  resolveControlPanelExperimentEnvironment: (input: unknown) => resolveMock(input),
}));

vi.mock("#lib/experiments/experiments-query", () => ({
  experimentDetailQuery: (input: unknown) => detailQueryMock(input),
  experimentsListQuery: () => listQueryMock(),
}));

vi.mock("#components/experiments/experiment-draft-wizard", () => ({
  ExperimentDraftWizard: () => null,
}));

const { Route: experimentRoute, loadExperimentRoute } = await import(
  "./$orgSlug.$appSlug.$env.experiments.$experimentId"
);
const { loadExperimentDraftRoute } = await import(
  "./$orgSlug.$appSlug.$env.experiments_.$experimentId.draft"
);

describe("Experiment detail route identity", () => {
  it("builds the scoped title from server-loaded Experiment data", async () => {
    const head = experimentRoute.options.head;
    if (!head) throw new Error("Experiment route has no document head");

    const result = await head({
      loaderData: {
        experimentId: "exp_checkout",
        experimentName: "Checkout copy",
        guarded: false,
      },
      params: { appSlug: "checkout", env: "prod" },
    } as never);

    expect(result.meta).toContainEqual({
      title: "Checkout copy · checkout · prod · splitch",
    });
  });

  it("loads a namespaced `new` key without reading the Analysis-backed list", async () => {
    resolveMock.mockResolvedValue({
      ok: true,
      data: { kind: "experiment", experimentId: "exp_new", experimentKey: "new" },
    });
    const ensureQueryData = vi.fn(async () => ({ experiment: { name: "New checkout" } }));

    await expect(
      loadExperimentRoute({
        queryClient: { ensureQueryData } as unknown as QueryClient,
        scoped: scopedContext(),
        experimentRef: "~new",
        href: "/acme/checkout/dev/experiments/~new",
        pathname: "/acme/checkout/dev/experiments/~new",
      }),
    ).resolves.toEqual({
      experimentId: "exp_new",
      experimentName: "New checkout",
      guarded: false,
    });

    expect(resolveMock).toHaveBeenCalledWith({
      data: {
        appId: "app_1",
        targetEnvironmentId: "env_dev",
        experimentRef: "new",
        referenceKind: "key",
        runId: undefined,
      },
    });
    expect(listQueryMock).not.toHaveBeenCalled();
    expect(detailQueryMock).toHaveBeenCalledWith({
      appId: "app_1",
      environmentId: "env_dev",
      experimentId: "exp_new",
    });
    expect(ensureQueryData).toHaveBeenCalledOnce();
  });

  it("loads a canonical percent-encoded key after the Router decodes the parameter", async () => {
    resolveMock.mockResolvedValue({
      ok: true,
      data: { kind: "experiment", experimentId: "exp_space", experimentKey: "hello world" },
    });
    const ensureQueryData = vi.fn(async () => ({ experiment: { name: "Hello world" } }));

    await expect(
      loadExperimentRoute({
        queryClient: { ensureQueryData } as unknown as QueryClient,
        scoped: scopedContext(),
        experimentRef: "~hello world",
        href: "/acme/checkout/dev/experiments/~hello%20world",
        pathname: "/acme/checkout/dev/experiments/~hello%20world",
      }),
    ).resolves.toEqual({
      experimentId: "exp_space",
      experimentName: "Hello world",
      guarded: false,
    });

    expect(ensureQueryData).toHaveBeenCalledOnce();
  });

  it("loads a draft directly without reading the Analysis-backed list", async () => {
    resolveMock.mockResolvedValue({
      ok: true,
      data: { kind: "experiment", experimentId: "exp_new", experimentKey: "new" },
    });
    const ensureQueryData = vi.fn(async () => ({ experiment: { name: "New checkout" } }));

    await expect(
      loadExperimentDraftRoute({
        queryClient: { ensureQueryData } as unknown as QueryClient,
        scoped: scopedContext(),
        experimentRef: "~new",
        href: "/acme/checkout/dev/experiments/~new/draft",
        pathname: "/acme/checkout/dev/experiments/~new/draft",
      }),
    ).resolves.toEqual({ experimentId: "exp_new", experimentName: "New checkout" });

    expect(listQueryMock).not.toHaveBeenCalled();
    expect(ensureQueryData).toHaveBeenCalledOnce();
  });

  it("loads a draft with a percent-encoded key after the Router decodes the parameter", async () => {
    resolveMock.mockResolvedValue({
      ok: true,
      data: { kind: "experiment", experimentId: "exp_space", experimentKey: "hello world" },
    });
    const ensureQueryData = vi.fn(async () => ({ experiment: { name: "Hello world" } }));

    await expect(
      loadExperimentDraftRoute({
        queryClient: { ensureQueryData } as unknown as QueryClient,
        scoped: scopedContext(),
        experimentRef: "~hello world",
        href: "/acme/checkout/dev/experiments/~hello%20world/draft",
        pathname: "/acme/checkout/dev/experiments/~hello%20world/draft",
      }),
    ).resolves.toEqual({ experimentId: "exp_space", experimentName: "Hello world" });

    expect(ensureQueryData).toHaveBeenCalledOnce();
  });
});

function scopedContext(): ScopedLoaderContext {
  return {
    session: {} as ScopedLoaderContext["session"],
    navigation: {
      orgs: [
        {
          orgId: "org_1",
          orgSlug: "acme",
          apps: [
            {
              appId: "app_1",
              appSlug: "checkout",
              environments: [
                { environmentId: "env_dev", env: "dev", name: "Development", guarded: false },
              ],
            },
          ],
        },
      ],
    },
    scope: {
      orgId: "org_1",
      orgSlug: "acme",
      orgRole: "member",
      appId: "app_1",
      appSlug: "checkout",
      appRole: "member",
      environmentId: "env_dev",
      env: "dev",
    },
  };
}
