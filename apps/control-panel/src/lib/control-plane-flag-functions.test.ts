import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizedFlagsClients: vi.fn(),
  controlPanelBindings: vi.fn(),
  createRepository: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@splitch/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@splitch/db")>()),
  createRepository: mocks.createRepository,
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator: () => ({ handler: (handler: unknown) => handler }),
  }),
}));
vi.mock("./bindings", () => ({ controlPanelBindings: mocks.controlPanelBindings }));
vi.mock("./panel-authorized-clients", () => ({
  authorizedFlagDetailClients: vi.fn(),
  authorizedFlagsClient: vi.fn(),
  authorizedFlagsClients: mocks.authorizedFlagsClients,
}));

const { loadControlPanelFlagsMatrix } = await import("./control-plane-flag-functions");

describe("Flags Matrix authorization", () => {
  it("returns unauthorized before opening the D1 repository", async () => {
    mocks.authorizedFlagsClients.mockResolvedValue({
      ok: false,
      result: {
        ok: false,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      },
    });
    const invoke = loadControlPanelFlagsMatrix as unknown as (input: {
      data: { appId: string; environmentIds: string[] };
    }) => Promise<unknown>;

    const result = await invoke({ data: { appId: "app_1", environmentIds: ["env_1"] } });

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(mocks.controlPanelBindings).not.toHaveBeenCalled();
    expect(mocks.createRepository).not.toHaveBeenCalled();
  });
});
