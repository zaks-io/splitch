import { expect, it, vi } from "vitest";
import worker from "./server";

vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: vi.fn() } }));
vi.mock("#lib/apps/control-plane-app-functions", () => ({ createControlPanelApp: vi.fn() }));
vi.mock("#lib/flags/control-plane-flag-functions", () => ({
  createControlPanelFlag: vi.fn(),
  loadControlPanelFlags: vi.fn(),
}));
vi.mock("#lib/shell/control-plane-palette-functions", () => ({
  loadControlPanelPaletteIndex: vi.fn(),
}));
vi.mock("#lib/organizations/org-app-list-functions", () => ({ loadOrgAppList: vi.fn() }));
vi.mock("#lib/live-updates/live-update-authorization", () => ({
  authorizeLiveUpdateUpgrade: vi.fn(),
}));
vi.mock("#lib/shared/bindings", () => ({ controlPanelLiveUpdateBindings: vi.fn() }));

it.each(["GET", "HEAD"])(
  "answers %s health before Start with the fleet run header and deployment evidence",
  async (method) => {
    const response = await worker.fetch(
      new Request("https://app.splitch.test/health", { method }) as never,
      {
        SENTRY_DSN: "https://example@sentry.io/1",
        SPLITCH_PLATFORM_TARGET: "production",
        SPLITCH_LOCAL_E2E_RUN_ID: "health-fast-path-test",
        SPLITCH_DEPLOYED_COMMIT_SHA: "a".repeat(40),
      } as never,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-splitch-local-e2e-run-id")).toBe("health-fast-path-test");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    if (method === "HEAD") expect(response.body).toBeNull();
    else
      expect(await response.json()).toEqual({
        ok: true,
        service: "splitch-control-panel",
        platformTarget: "production",
        deployedCommitSha: "a".repeat(40),
      });
  },
);
