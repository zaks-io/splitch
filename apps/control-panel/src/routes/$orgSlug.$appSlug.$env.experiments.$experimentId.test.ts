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

const { loadExperimentRoute } = await import("./$orgSlug.$appSlug.$env.experiments.$experimentId");
const { loadExperimentDraftRoute } = await import(
  "./$orgSlug.$appSlug.$env.experiments_.$experimentId.draft"
);

describe("Experiment detail route identity", () => {
  it("loads a namespaced `new` key without reading the Analysis-backed list", async () => {
    resolveMock.mockResolvedValue({
      ok: true,
      data: { kind: "experiment", experimentId: "exp_new", experimentKey: "new" },
    });
    const ensureQueryData = vi.fn(async () => ({ id: "exp_new" }));

    await expect(
      loadExperimentRoute({
        queryClient: { ensureQueryData } as unknown as QueryClient,
        scoped: scopedContext(),
        experimentRef: "~new",
        href: "/acme/checkout/dev/experiments/~new",
        pathname: "/acme/checkout/dev/experiments/~new",
      }),
    ).resolves.toEqual({ experimentId: "exp_new", guarded: false });

    expect(resolveMock).toHaveBeenCalledWith({
      data: {
        appId: "app_1",
        targetEnvironmentId: "env_dev",
        experimentRef: "new",
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

  it("loads a draft directly without reading the Analysis-backed list", async () => {
    resolveMock.mockResolvedValue({
      ok: true,
      data: { kind: "experiment", experimentId: "exp_new", experimentKey: "new" },
    });
    const ensureQueryData = vi.fn(async () => ({ id: "exp_new" }));

    await expect(
      loadExperimentDraftRoute({
        queryClient: { ensureQueryData } as unknown as QueryClient,
        scoped: scopedContext(),
        experimentRef: "~new",
        href: "/acme/checkout/dev/experiments/~new/draft",
        pathname: "/acme/checkout/dev/experiments/~new/draft",
      }),
    ).resolves.toEqual({ experimentId: "exp_new" });

    expect(listQueryMock).not.toHaveBeenCalled();
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
