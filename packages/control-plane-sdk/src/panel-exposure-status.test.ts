import { describe, expect, it, vi } from "vitest";
import { createPanelExposureStatusClient } from "./panel-exposure-status";

describe("Panel Environment Exposure status transport", () => {
  it("reads the scoped Control Plane route and validates the closed response union", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ state: "received", firstExposureAt: "2026-08-18T12:34:56.789Z" }),
    );
    const client = createPanelExposureStatusClient({ fetch: fetcher });

    await expect(
      client.get({ appId: "app/checkout", environmentId: "env dev" }),
    ).resolves.toMatchObject({
      ok: true,
      data: { state: "received", firstExposureAt: "2026-08-18T12:34:56.789Z" },
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://control-plane.internal/apps/app%2Fcheckout/envs/env%20dev/exposure-status",
    );

    fetcher.mockResolvedValueOnce(Response.json({ state: "unavailable", firstExposureAt: null }));
    await expect(client.get({ appId: "app_checkout", environmentId: "env_dev" })).rejects.toThrow(
      "environment_exposure_status_get returned an invalid response body",
    );
  });
});
