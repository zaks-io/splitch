import type { FlagConfigGetOutput, FlagsClient } from "@splitch/control-plane-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  classifyDrift,
  createDelegationEnvironment,
  readFlagsMatrix,
  type FlagsMatrixCell,
} from "./flags-matrix-data";

describe("Flags matrix data", () => {
  it("reads the catalog once and maps Configuration per Environment", async () => {
    const list = vi.fn(async () => catalog());
    const devGet = vi.fn<FlagsClient["getConfig"]>(async ({ flagId }) => ({
      ok: true,
      status: 200,
      data: config("env_dev", flagId, flagId === "flag_checkout"),
    }));
    const prodGet = vi.fn<FlagsClient["getConfig"]>(async ({ flagId }) =>
      flagId === "flag_checkout"
        ? { ok: true, status: 200, data: config("env_prod", flagId, false) }
        : notFound(),
    );
    const prodList = vi.fn<FlagsClient["list"]>();

    const result = await readFlagsMatrix(
      [
        { environmentId: "env_dev", flags: { list, getConfig: devGet } },
        { environmentId: "env_prod", flags: { list: prodList, getConfig: prodGet } },
      ],
      "app_checkout",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        readTruncated: true,
        readLimit: 200,
        rows: [
          {
            definition: {
              id: "flag_checkout",
              key: "new-checkout",
              variantCount: 2,
              variantLabels: { var_disabled: "disabled", var_enabled: "enabled" },
            },
            cells: {
              env_dev: {
                enabled: true,
                rolloutPercentages: [25],
                controllingExperiment: { id: "exp_1", name: "Checkout" },
              },
              env_prod: { enabled: false, rolloutPercentages: [25] },
            },
          },
          { definition: { key: "banner" }, cells: { env_dev: { enabled: false }, env_prod: null } },
        ],
      },
    });
    expect(list).toHaveBeenCalledOnce();
    expect(prodList).not.toHaveBeenCalled();
    expect(devGet).toHaveBeenCalledTimes(2);
    expect(prodGet).toHaveBeenCalledTimes(2);
  });

  it("propagates a Configuration failure other than FLAG_NOT_FOUND", async () => {
    const failure = {
      ok: false as const,
      status: 503,
      error: { code: "INTERNAL_SERVER_ERROR" as const, message: "down", details: {} },
    };
    const result = await readFlagsMatrix(
      [
        {
          environmentId: "env_dev",
          flags: { list: vi.fn(async () => catalog()), getConfig: vi.fn(async () => failure) },
        },
      ],
      "app_checkout",
    );
    expect(result).toBe(failure);
  });

  it("propagates the catalog failure without reading Configurations", async () => {
    const failure = {
      ok: false as const,
      status: 503,
      error: { code: "INTERNAL_SERVER_ERROR" as const, message: "down", details: {} },
    };
    const getConfig = vi.fn<FlagsClient["getConfig"]>();
    const result = await readFlagsMatrix(
      [{ environmentId: "env_dev", flags: { list: vi.fn(async () => failure), getConfig } }],
      "app_checkout",
    );
    expect(result).toBe(failure);
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("rejects an empty Environment list", async () => {
    await expect(readFlagsMatrix([], "app_checkout")).rejects.toThrow(
      "Flags matrix requires at least one Environment",
    );
  });
});

describe("Flag drift", () => {
  const enabled = cell(true, [25]);
  const disabled = cell(false, [25]);

  it.each([
    [null, null, "unconfigured"],
    [enabled, null, "missing-in-target"],
    [null, enabled, "missing-in-source"],
    [enabled, disabled, "enabled-differs"],
    [enabled, cell(true, [50]), "rollout-differs"],
    [enabled, cell(true, [25, 50]), "rollout-differs"],
    [enabled, cell(true, [25]), "in-sync"],
  ] as const)("classifies %s and %s as %s", (source, target, expected) => {
    expect(classifyDrift(source, target)).toBe(expected);
  });
});

describe("Flag creation delegation", () => {
  const guarded = { env: "prod", environmentId: "env_prod", guarded: true };
  const open = { env: "dev", environmentId: "env_dev", guarded: false };

  it("uses the first non-guarded Environment", () => {
    expect(createDelegationEnvironment([guarded, open])).toBe(open);
  });

  it("uses the first Environment when every Environment is guarded", () => {
    expect(createDelegationEnvironment([guarded, { ...guarded, env: "staging" }])).toBe(guarded);
  });
});

function cell(enabled: boolean, rolloutPercentages: number[]): FlagsMatrixCell {
  return {
    enabled,
    availableVariantCount: 2,
    rolloutPercentages,
    controllingExperiment: null,
  };
}

function config(environmentId: string, flagId: string, enabled: boolean): FlagConfigGetOutput {
  return {
    flagId,
    environmentId,
    version: 1,
    enabled,
    availableVariantNames: ["disabled", "enabled"],
    targetingRules: [
      {
        id: `rule_${environmentId}`,
        flagId,
        priority: 0,
        conditions: [],
        variantId: "var_enabled",
        percentageRollout: { percentage: 25, salt: environmentId },
      },
    ],
    rollout: null,
    experiment: flagId === "flag_checkout" ? { id: "exp_1", name: "Checkout" } : null,
  };
}

function notFound() {
  return {
    ok: false as const,
    status: 404,
    error: { code: "FLAG_NOT_FOUND" as const, message: "not found", details: {} },
  };
}

function catalog() {
  return {
    ok: true as const,
    status: 200,
    data: {
      readTruncated: true,
      readLimit: 200,
      items: [definition("flag_checkout", "new-checkout"), definition("flag_banner", "banner")],
    },
  };
}

function definition(id: string, key: string) {
  return {
    id,
    appId: "app_checkout",
    key,
    name: key,
    schema: { type: "boolean" as const },
    variants: [
      { id: "var_disabled", name: "disabled", value: false },
      { id: "var_enabled", name: "enabled", value: true },
    ],
    defaultVariantId: "var_disabled",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}
