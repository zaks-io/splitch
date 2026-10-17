import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

const empty = { items: [], readLimit: 2, readTruncated: false, cursor: null };
describe("App audit SDK", () => {
  it("calls the canonical Control Plane route with filters and continuation", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer fixture");
      const url = new URL(request.url);
      expect(url.pathname).toBe("/apps/app_1/audit");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        limit: "2",
        cursor: "page_2",
        runId: "run_1",
        action: "runs_end",
      });
      return Response.json(empty);
    });
    const result = await createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: fetcher,
    }).apps.listAudit(
      { appId: "app_1", limit: 2, cursor: "page_2", runId: "run_1", action: "runs_end" },
      { authorization: "Bearer fixture" },
    );
    expect(result).toEqual({ ok: true, status: 200, data: empty });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never passes unknown response JSON through the existing compatibility parser", async () => {
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async () => Response.json({ ...empty, unknown: "CANARY" }),
    });
    expect(await sdk.apps.listAudit({ appId: "app_1" })).toEqual({
      ok: true,
      status: 200,
      data: empty,
    });
  });
});
