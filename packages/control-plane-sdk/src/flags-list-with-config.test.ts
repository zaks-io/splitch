import { describe, expect, it } from "vitest";
import { createControlPlaneSdk } from "./index";

const flag = {
  id: "flag_checkout",
  appId: "app_local",
  key: "checkout",
  name: "Checkout",
  variants: [{ id: "var_on", name: "on", value: true }],
  defaultVariantId: "var_on",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

describe("flags.list with Environment configuration", () => {
  it("carries Environment scope in one request and parses the inline summary", async () => {
    let requestedUrl = "";
    const withConfiguration = {
      items: [
        {
          ...flag,
          flagConfiguration: {
            enabled: true,
            rollout: 25,
            defaultVariant: "on",
            availableVariantNames: ["on"],
            targetingRuleRolloutPercentages: [25],
            experiment: null,
          },
        },
      ],
      readTruncated: false,
      readLimit: 200,
      cursor: null,
    };
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(withConfiguration);
      },
    });

    const result = await sdk.flags.list({
      appId: "app_local",
      environmentId: "env_prod",
    });

    expect(new URL(requestedUrl).searchParams.get("environmentId")).toBe("env_prod");
    expect(result).toEqual({ ok: true, status: 200, data: withConfiguration });
  });

  it("sends an empty Environment ID instead of treating it as omitted", async () => {
    let requestedUrl = "";
    const bareList = { items: [], readTruncated: false, readLimit: 200, cursor: null };
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(bareList);
      },
    });

    await sdk.flags.list({ appId: "app_local", environmentId: "" });

    const url = new URL(requestedUrl);
    expect(url.searchParams.has("environmentId")).toBe(true);
    expect(url.searchParams.get("environmentId")).toBe("");
  });

  it("forwards hydrated Configuration selection through the derived query", async () => {
    let requestedUrl = "";
    const hydrated = {
      items: [{ ...flag, configurations: [] }],
      readTruncated: false,
      readLimit: 200,
      cursor: null,
    };
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(hydrated);
      },
    });

    const result = await sdk.flags.list({
      appId: "app_local",
      include: "config",
      envs: "env_dev,env_prod",
    });

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("include")).toBe("config");
    expect(url.searchParams.get("envs")).toBe("env_dev,env_prod");
    expect(result).toEqual({ ok: true, status: 200, data: hydrated });
  });
});
