import { describe, expect, it, vi } from "vitest";
import { createPanelSettingsClient } from "./panel-settings";

const settings = {
  environment: {
    id: "env_1",
    appId: "app_1",
    key: "dev",
    name: "Development",
    policy: {
      variantAvailability: "allow",
      targetingRolloutValue: "allow",
      enabledState: "allow",
      startExperimentRun: "allow",
    },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  },
  clientKey: {
    keyId: "ck_1",
    appId: "app_1",
    environmentId: "env_1",
    keyMaterial: "ck_public",
    originAllowlist: null,
    isOriginOpen: true,
    createdAt: "2026-07-29T00:00:00.000Z",
  },
  apiKeys: [
    {
      keyId: "ak_1",
      keyHashPrefix: "012345abcdef",
      scopes: ["data-plane:evaluate", "data-plane:write"],
      createdAt: "2026-07-29T00:00:00.000Z",
      revokedAt: null,
    },
  ],
};

describe("panel settings binding transport", () => {
  it("reads metadata without accepting a secret-bearing response", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(settings),
    );
    const client = createPanelSettingsClient({ fetch: fetcher });

    await expect(client.read({ appId: "app_1", environmentId: "env_1" })).resolves.toMatchObject({
      ok: true,
      data: { apiKeys: [{ keyHashPrefix: "012345abcdef" }] },
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://control-plane.internal/control-panel/apps/app_1/envs/env_1/settings",
    );

    fetcher.mockResolvedValueOnce(
      Response.json({
        ...settings,
        apiKeys: [{ ...settings.apiKeys[0], value: "sk_must_not_survive" }],
      }),
    );
    await expect(client.read({ appId: "app_1", environmentId: "env_1" })).rejects.toThrow(
      "panel_settings_get returned an invalid response body",
    );
  });

  it("uses fixed data-plane scopes when provisioning", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({
        credential: {
          keyId: "ak_2",
          appId: "app_1",
          environmentId: "env_1",
          scopes: ["data-plane:evaluate", "data-plane:write"],
          createdAt: "2026-07-29T00:00:00.000Z",
        },
        value: "sk_once",
      });
    });
    const client = createPanelSettingsClient({ fetch: fetcher });

    await expect(
      client.provisionApiKey({ appId: "app_1", environmentId: "env_1" }),
    ).resolves.toMatchObject({ ok: true, data: { value: "sk_once" } });
    expect(await requests[0]?.json()).toEqual({
      scopes: ["data-plane:evaluate", "data-plane:write"],
    });
  });
});
