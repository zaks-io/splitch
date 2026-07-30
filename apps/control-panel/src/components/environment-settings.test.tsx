import type { PanelEnvironmentSettings } from "@splitch/control-plane-sdk/panel-settings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("#lib/control-plane-settings-functions", () => ({
  loadControlPanelSettings: vi.fn(),
  lockControlPanelClientKey: vi.fn(),
  provisionControlPanelApiKey: vi.fn(),
  revokeControlPanelApiKey: vi.fn(),
  updateControlPanelEnvironmentPolicy: vi.fn(),
}));

const { EnvironmentSettings } = await import("./environment-settings");

describe("EnvironmentSettings", () => {
  it("renders the open Client Key warning, metadata-only API Keys, and Policy growth path", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <EnvironmentSettings settings={settings} />
      </QueryClientProvider>,
    );

    expect(html).toContain("accepts requests from any origin");
    expect(html).toContain("Lock to origins");
    expect(html).toContain("sha256:aaaaaaaaaaaa");
    expect(Object.keys(settings.apiKeys[0] ?? {}).sort()).toEqual([
      "createdAt",
      "keyHashPrefix",
      "keyId",
      "revokedAt",
      "scopes",
    ]);
    expect(html).toContain("Variant availability");
    expect(html).toContain("Start an Experiment Run");
    expect(html).toContain("Coming soon");
    expect(html).toContain("Never gated");
    expect(html).toContain('data-testid="kill-switch-policy"');
  });
});

const settings: PanelEnvironmentSettings = {
  environment: {
    id: "env_prod",
    appId: "app_checkout",
    key: "prod",
    name: "Production",
    policy: {
      variantAvailability: "confirm",
      targetingRolloutValue: "confirm",
      enabledState: "confirm",
      startExperimentRun: "confirm",
    },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  },
  clientKey: {
    keyId: "ck_prod",
    appId: "app_checkout",
    environmentId: "env_prod",
    keyMaterial: "pk_public",
    originAllowlist: null,
    isOriginOpen: true,
    rateLimitRps: 100,
    revokedAt: null,
    createdAt: "2026-07-29T00:00:00.000Z",
  },
  apiKeys: [
    {
      keyId: "ak_server",
      keyHashPrefix: "aaaaaaaaaaaa",
      scopes: ["data-plane:evaluate", "data-plane:write"],
      createdAt: "2026-07-29T00:00:00.000Z",
      revokedAt: null,
    },
  ],
};
