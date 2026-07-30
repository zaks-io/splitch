import { describe, expect, it } from "vitest";
import { createControlPlaneSdk } from "./index";

const flagConfig = {
  flagId: "flag_checkout",
  environmentId: "env_local",
  version: 2,
  enabled: true,
  availableVariantNames: ["on"],
  targetingRules: [],
  rollout: null,
  experiment: null,
};

describe("typed Flag Configuration routes", () => {
  it("gets a contract-parsed Flag Configuration", async () => {
    let capturedUrl: string | undefined;
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async (input) => {
        capturedUrl = input instanceof Request ? input.url : String(input);
        return Response.json({ ...flagConfig, unexpected: "removed" });
      },
    });

    await expect(
      sdk.flags.getConfig({
        appId: "app_local",
        environmentId: "env_local",
        flagId: "flag_checkout",
      }),
    ).resolves.toEqual({ ok: true, status: 200, data: flagConfig });
    expect(capturedUrl).toBe(
      "https://control-plane.test/apps/app_local/envs/env_local/flags/flag_checkout/config",
    );
  });

  it("updates with path params excluded from the body", async () => {
    let capturedBody: unknown;
    let capturedAuthorization: string | null = null;
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async (_input, init) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        capturedAuthorization = new Headers(init?.headers).get("authorization");
        return Response.json(flagConfig);
      },
    });

    await sdk.flags.updateConfig(
      {
        appId: "app_local",
        environmentId: "env_local",
        flagId: "flag_checkout",
        enabled: true,
      },
      { authorization: "Bearer control-plane-token" },
    );

    expect(capturedBody).toEqual({ enabled: true });
    expect(capturedAuthorization).toBe("Bearer control-plane-token");
  });
});
