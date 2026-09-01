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

  it("deduplicates concurrent reads but refreshes authorization on the next route load", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000 } },
    });
    loadScopedSessionMock
      .mockResolvedValueOnce({ kind: "ok", context: { session: { userId: "user_1" } } })
      .mockResolvedValueOnce({ kind: "forbidden" });

    const concurrent = await Promise.all([
      queryClient.fetchQuery(scopedSessionQuery(params, "/acme/checkout-api/production/flags")),
      queryClient.fetchQuery(scopedSessionQuery(params, "/acme/checkout-api/production/flags")),
    ]);
    const refreshed = await queryClient.fetchQuery(
      scopedSessionQuery(params, "/acme/checkout-api/production/flags"),
    );

    expect(concurrent).toEqual([
      { kind: "ok", context: { session: { userId: "user_1" } } },
      { kind: "ok", context: { session: { userId: "user_1" } } },
    ]);
    expect(refreshed).toEqual({ kind: "forbidden" });
    expect(loadScopedSessionMock).toHaveBeenCalledTimes(2);
    expect(loadScopedSessionMock).toHaveBeenCalledWith({
      data: { ...params, visitPath: "/acme/checkout-api/production/flags" },
    });
  });
});
