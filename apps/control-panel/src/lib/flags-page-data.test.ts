import type { FlagConfigGetOutput, FlagsClient } from "@splitch/control-plane-sdk";
import { describe, expect, it, vi } from "vitest";
import { readFlagsPage } from "./flags-page-data";

describe("Flags route data", () => {
  it("reads each App-level definition through the active Environment config endpoint", async () => {
    const getConfig = vi.fn<FlagsClient["getConfig"]>(async (input) => ({
      ok: true,
      status: 200,
      data: input.environmentId === "env_dev" ? devConfig() : prodConfig(),
    }));
    const flags = flagsClient(getConfig);

    const dev = await readFlagsPage(flags, { appId: "app_checkout", environmentId: "env_dev" });
    const prod = await readFlagsPage(flags, { appId: "app_checkout", environmentId: "env_prod" });

    expect(dev).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            definition: { id: "flag_checkout", key: "new-checkout", variantCount: 2 },
            configuration: {
              enabled: true,
              availableVariantCount: 2,
              rolloutPercentages: [25],
            },
          },
        ],
      },
    });
    expect(prod).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            configuration: {
              enabled: false,
              availableVariantCount: 1,
              rolloutPercentages: [],
            },
          },
        ],
      },
    });
    expect(getConfig).toHaveBeenNthCalledWith(1, {
      appId: "app_checkout",
      environmentId: "env_dev",
      flagId: "flag_checkout",
    });
    expect(getConfig).toHaveBeenNthCalledWith(2, {
      appId: "app_checkout",
      environmentId: "env_prod",
      flagId: "flag_checkout",
    });
  });

  it("shows a definition without masquerading it as configured in this Environment", async () => {
    const flags = flagsClient(
      vi.fn<FlagsClient["getConfig"]>(async () => ({
        ok: false,
        status: 404,
        error: { code: "FLAG_NOT_FOUND", message: "Flag Configuration not found", details: {} },
      })),
    );

    const result = await readFlagsPage(flags, {
      appId: "app_checkout",
      environmentId: "env_prod",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { items: [{ configuration: null }] },
    });
  });

  it("carries the catalog read's own truncation signal instead of re-deriving one", async () => {
    // The endpoint OBSERVES truncation one row past its ceiling. Nothing on this
    // side can reconstruct that from a page, so the page data must pass it
    // through unchanged — including the case where the two disagree.
    const flags = flagsClient(
      vi.fn<FlagsClient["getConfig"]>(async () => ({ ok: true, status: 200, data: prodConfig() })),
      { readTruncated: true, readLimit: 200 },
    );

    const result = await readFlagsPage(flags, {
      appId: "app_checkout",
      environmentId: "env_prod",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        readTruncated: true,
        readLimit: 200,
        items: [{ definition: { key: "new-checkout" } }],
      },
    });
  });
});

function flagsClient(
  getConfig: FlagsClient["getConfig"],
  bound: { readTruncated: boolean; readLimit: number } = { readTruncated: false, readLimit: 200 },
): Pick<FlagsClient, "list" | "getConfig"> {
  return {
    getConfig,
    list: vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: {
        ...bound,
        items: [
          {
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
            createdAt: "2026-07-18T00:00:00.000Z",
            updatedAt: "2026-07-18T00:00:00.000Z",
          },
        ],
      },
    })),
  };
}

function devConfig(): FlagConfigGetOutput {
  return {
    flagId: "flag_checkout",
    environmentId: "env_dev",
    version: 2,
    enabled: true,
    availableVariantNames: ["disabled", "enabled"],
    targetingRules: [
      {
        id: "rule_dev",
        flagId: "flag_checkout",
        priority: 0,
        conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
        variantId: "var_enabled",
        percentageRollout: { percentage: 25, salt: "dev" },
      },
    ],
    rollout: null,
    experiment: null,
  };
}

function prodConfig(): FlagConfigGetOutput {
  return {
    flagId: "flag_checkout",
    environmentId: "env_prod",
    version: 1,
    enabled: false,
    availableVariantNames: ["disabled"],
    targetingRules: [],
    rollout: null,
    experiment: null,
  };
}
