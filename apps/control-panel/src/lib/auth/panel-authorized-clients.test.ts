import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flagsClient: vi.fn(),
  appSettingsClient: vi.fn(),
  environmentSettingsClient: vi.fn(),
  exposureStatusClient: vi.fn(),
  getRequest: vi.fn(),
  loadSession: vi.fn(),
  segmentsClient: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));
vi.mock("#lib/shared/bindings", () => ({
  controlPanelMutationBindings: () => ({
    CONTROL_PLANE_API: { fetch: vi.fn() },
    CONTROL_PANEL_DELEGATION_SECRET: "delegation-secret".padEnd(32, "0"),
  }),
}));
vi.mock("#lib/shared/control-plane-apps", () => ({
  createControlPanelApprovalsClient: vi.fn(),
  createControlPanelFlagsClient: mocks.flagsClient,
}));
vi.mock("#lib/segments/control-plane-segments", () => ({
  createControlPanelSegmentsClient: mocks.segmentsClient,
}));
vi.mock("#lib/apps/control-plane-app-settings", () => ({
  createControlPanelAppSettingsClient: mocks.appSettingsClient,
}));
vi.mock("#lib/settings/control-plane-settings", () => ({
  createControlPanelSettingsClient: mocks.environmentSettingsClient,
}));
vi.mock("#lib/environments/control-plane-exposure-status", () => ({
  createControlPanelExposureStatusClient: mocks.exposureStatusClient,
}));
vi.mock("#lib/sessions/session-refresh", () => ({ loadSessionFromRequest: mocks.loadSession }));

const { authorizedAppSettingsPageClients, authorizedFlagDetailClients, authorizedFlagsClients } =
  await import("#lib/auth/panel-authorized-clients");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRequest.mockReturnValue(new Request("https://panel.example.test/flags"));
  mocks.loadSession.mockResolvedValue({
    ok: true,
    tokenHash: "token-hash",
    session: { userId: "user_1", expiresAt: 1_800_000_000 },
  });
  mocks.flagsClient.mockReturnValue({ kind: "flags" });
  mocks.segmentsClient.mockReturnValue({ kind: "segments" });
  mocks.appSettingsClient.mockReturnValue({ kind: "app-settings" });
  mocks.environmentSettingsClient.mockReturnValue({ kind: "environment-settings" });
  mocks.exposureStatusClient.mockReturnValue({ kind: "exposure-status" });
});

describe("combined authorized clients", () => {
  it("loads one session before creating every Flags Matrix client", async () => {
    const result = await authorizedFlagsClients(["env_1", "env_2", "env_3"]);

    expect(result.ok).toBe(true);
    expect(mocks.loadSession).toHaveBeenCalledOnce();
    expect(mocks.flagsClient).toHaveBeenCalledTimes(3);
  });

  it("loads one session before creating both Flag detail clients", async () => {
    const result = await authorizedFlagDetailClients("env_1");

    expect(result.ok).toBe(true);
    expect(mocks.loadSession).toHaveBeenCalledOnce();
    expect(mocks.flagsClient).toHaveBeenCalledOnce();
    expect(mocks.segmentsClient).toHaveBeenCalledOnce();
  });

  it("loads one session before creating every App Settings page client", async () => {
    const result = await authorizedAppSettingsPageClients("env_1");

    expect(result.ok).toBe(true);
    expect(mocks.loadSession).toHaveBeenCalledOnce();
    expect(mocks.appSettingsClient).toHaveBeenCalledOnce();
    expect(mocks.environmentSettingsClient).toHaveBeenCalledOnce();
    expect(mocks.exposureStatusClient).toHaveBeenCalledOnce();
  });
});
