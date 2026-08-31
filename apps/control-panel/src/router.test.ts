import { describe, expect, it, vi } from "vitest";

vi.mock("./routeTree.gen", async () => {
  const { createRootRoute } = await import("@tanstack/react-router");
  return { routeTree: createRootRoute() };
});

vi.mock("#lib/observability/panel-sentry-client", () => ({
  initControlPanelClientSentry: vi.fn().mockResolvedValue(undefined),
}));

import { getRouter } from "./router";

describe("Control Panel router freshness", () => {
  it("reuses hydrated query and intent-preload results", async () => {
    const router = await getRouter();

    expect(router.options.context.queryClient.getDefaultOptions().queries?.staleTime).toBe(60_000);
    expect(router.options.defaultPreloadStaleTime).toBe(30_000);
  });
});
