import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flagsClient: vi.fn(),
  getRequest: vi.fn(),
  loadSession: vi.fn(),
  segmentsClient: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));
vi.mock("./bindings", () => ({
  controlPanelMutationBindings: () => ({
    CONTROL_PLANE_API: { fetch: vi.fn() },
    CONTROL_PANEL_DELEGATION_SECRET: "delegation-secret".padEnd(32, "0"),
  }),
}));
vi.mock("./control-plane-apps", () => ({
  createControlPanelApprovalsClient: vi.fn(),
  createControlPanelFlagsClient: mocks.flagsClient,
}));
vi.mock("./control-plane-segments", () => ({
  createControlPanelSegmentsClient: mocks.segmentsClient,
}));
vi.mock("./session-refresh", () => ({ loadSessionFromRequest: mocks.loadSession }));

const { authorizedFlagDetailClients, authorizedFlagsClients } = await import(
  "./panel-authorized-clients"
);

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
});
