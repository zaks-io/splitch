import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizedFlagDetailClients: vi.fn(),
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
  authorizedFlagDetailClients: mocks.authorizedFlagDetailClients,
  authorizedFlagsClient: vi.fn(),
  authorizedFlagsClients: mocks.authorizedFlagsClients,
}));

const { createControlPanelFlag, loadControlPanelFlagsMatrix } = await import(
  "./control-plane-flag-functions"
);

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

describe("Flag creation implementation handoff", () => {
  it("reads back the current Configuration instead of building a prompt from create input", async () => {
    const flags = {
      create: vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        data: { key: "new-checkout" },
      }),
      get: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        data: {
          id: "flag_checkout",
          appId: "app_checkout",
          key: "new-checkout",
          name: "New Checkout",
          schema: { type: "boolean" },
          variants: [
            { id: "var_disabled", name: "disabled", value: false },
            { id: "var_enabled", name: "enabled", value: true },
          ],
          defaultVariantId: "var_disabled",
          createdAt: "2026-08-29T00:00:00.000Z",
        },
      }),
      getConfig: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        data: {
          flagId: "flag_checkout",
          environmentId: "env_dev",
          version: 3,
          enabled: true,
          availableVariantNames: ["disabled"],
          targetingRules: [],
          rollout: { percentage: 75 },
          experiment: null,
        },
      }),
    };
    const segments = { list: vi.fn() };
    segments.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        items: [],
        unparseable: [],
        affectedEnvironmentIds: {},
        readLimit: 200,
        readTruncated: false,
        cursor: null,
      },
    });
    mocks.authorizedFlagDetailClients.mockResolvedValue({
      ok: true,
      client: { flags, segments },
    });
    const invoke = createControlPanelFlag as unknown as (input: {
      data: unknown;
    }) => Promise<unknown>;

    const result = await invoke({
      data: {
        success: true,
        data: {
          appId: "app_checkout",
          environmentId: "env_dev",
          idempotencyKey: "idem_1",
          draft: {
            name: "New Checkout",
            key: "new-checkout",
            valueType: "boolean",
            schemaText: "",
            variants: [
              { name: "disabled", value: "false", description: "" },
              { name: "enabled", value: "true", description: "" },
            ],
            defaultIndex: 0,
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      data: {
        key: "new-checkout",
        configured: true,
        enabled: true,
        defaultVariant: "disabled",
        availableVariantNames: ["disabled"],
        baselineRolloutPercentage: 75,
        variants: [
          { name: "disabled", valueJson: "false", availability: "available" },
          { name: "enabled", valueJson: "true", availability: "unavailable" },
        ],
      },
    });
    expect(flags.get).toHaveBeenCalledWith({
      appId: "app_checkout",
      flagId: "new-checkout",
      by: "key",
    });
    expect(flags.getConfig).toHaveBeenCalledWith({
      appId: "app_checkout",
      environmentId: "env_dev",
      flagId: "flag_checkout",
    });
  });
});
