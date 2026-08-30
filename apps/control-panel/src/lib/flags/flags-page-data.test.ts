import type { FlagConfigGetOutput, FlagsClient } from "@splitch/control-plane-sdk";
import { describe, expect, it, vi } from "vitest";
import { readFlagsPage } from "#lib/flags/flags-page-data";

describe("Flags route data", () => {
  it("reads definitions and active Environment summaries in one list request", async () => {
    const flags = flagsClient((environmentId) =>
      environmentId === "env_dev" ? devConfig() : prodConfig(),
    );

    const dev = await readFlagsPage(flags, { appId: "app_checkout", environmentId: "env_dev" });
    const prod = await readFlagsPage(flags, { appId: "app_checkout", environmentId: "env_prod" });

    expect(dev).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            definition: {
              id: "flag_checkout",
              key: "new-checkout",
              variantCount: 2,
              variantLabels: { var_disabled: "disabled", var_enabled: "enabled" },
            },
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
    expect(flags.list).toHaveBeenNthCalledWith(1, {
      appId: "app_checkout",
      environmentId: "env_dev",
    });
    expect(flags.list).toHaveBeenNthCalledWith(2, {
      appId: "app_checkout",
      environmentId: "env_prod",
    });
  });

  it("shows a definition without masquerading it as configured in this Environment", async () => {
    const flags = flagsClient(() => null);

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
    const flags = flagsClient(() => prodConfig(), {
      readTruncated: true,
      readLimit: 200,
      cursor: null,
    });

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
  config: (environmentId: string | undefined) => FlagConfigGetOutput | null,
  bound: { readTruncated: boolean; readLimit: number; cursor: string | null } = {
    readTruncated: false,
    readLimit: 200,
    cursor: null,
  },
): Pick<FlagsClient, "list"> {
  return {
    list: vi.fn(async (input) => ({
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
            ...(config(input.environmentId)
              ? {
                  flagConfiguration: listConfig(config(input.environmentId) as FlagConfigGetOutput),
                }
              : {}),
          },
        ],
      },
    })),
  };
}

function listConfig(config: FlagConfigGetOutput) {
  return {
    enabled: config.enabled,
    rollout: config.rollout?.percentage ?? null,
    defaultVariant: "disabled",
    availableVariantNames: config.availableVariantNames,
    targetingRuleRolloutPercentages: config.targetingRules.flatMap((rule) =>
      rule.percentageRollout ? [rule.percentageRollout.percentage] : [],
    ),
    experiment: config.experiment,
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
