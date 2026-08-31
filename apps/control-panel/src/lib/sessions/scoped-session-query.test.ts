import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadScopedSessionMock = vi.fn();

vi.mock("#lib/sessions/session-functions", () => ({
  loadScopedSession: (...args: unknown[]) => loadScopedSessionMock(...args),
}));

const { scopedSessionQuery } = await import("#lib/sessions/scoped-session-query");

const params = { appSlug: "checkout-api", env: "production", orgSlug: "acme" };

describe("scopedSessionQuery", () => {
  beforeEach(() => {
    loadScopedSessionMock.mockReset();
  });

  it("shares one scope request across concurrent parent and child route reads", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000 } },
    });
    loadScopedSessionMock.mockResolvedValue({ kind: "ok", context: { scope: {} } });

    await Promise.all([
      queryClient.ensureQueryData(scopedSessionQuery(params)),
      queryClient.ensureQueryData(scopedSessionQuery(params)),
    ]);
    await queryClient.ensureQueryData(scopedSessionQuery(params));

    expect(loadScopedSessionMock).toHaveBeenCalledTimes(1);
    expect(loadScopedSessionMock).toHaveBeenCalledWith({ data: params });
  });
});
