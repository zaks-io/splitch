import type { FlagsClient } from "@splitch/control-plane-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  assertMatrixEnvironments,
  classifyDrift,
  createDelegationEnvironment,
  type FlagsMatrixCell,
  readFlagsMatrix,
} from "./flags-matrix-data";

describe("Flags matrix data", () => {
  it("reads each Environment once and maps its Configuration summaries", async () => {
    const devList = vi.fn<FlagsClient["list"]>(async () => catalog("env_dev"));
    const prodList = vi.fn<FlagsClient["list"]>(async () => catalog("env_prod"));

    const result = await readFlagsMatrix(
      [
        { environmentId: "env_dev", flags: { list: devList } },
        { environmentId: "env_prod", flags: { list: prodList } },
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
    expect(devList).toHaveBeenCalledOnce();
    expect(prodList).toHaveBeenCalledOnce();
  });

  it("propagates an Environment list failure", async () => {
    const failure = {
      ok: false as const,
      status: 503,
      error: { code: "INTERNAL_SERVER_ERROR" as const, message: "down", details: {} },
    };
    const result = await readFlagsMatrix(
      [
        {
          environmentId: "env_dev",
          flags: { list: vi.fn(async () => failure) },
        },
      ],
      "app_checkout",
    );
    expect(result).toBe(failure);
  });

  it("propagates the catalog Environment failure", async () => {
    const failure = {
      ok: false as const,
      status: 503,
      error: { code: "INTERNAL_SERVER_ERROR" as const, message: "down", details: {} },
    };
    const result = await readFlagsMatrix(
      [{ environmentId: "env_dev", flags: { list: vi.fn(async () => failure) } }],
      "app_checkout",
    );
    expect(result).toBe(failure);
  });

  it("rejects an empty Environment list", async () => {
    await expect(readFlagsMatrix([], "app_checkout")).rejects.toThrow(
      "Flags matrix requires at least one Environment",
    );
  });
});

describe("Flags matrix Environment guard", () => {
  const known = [{ environmentId: "env_dev" }, { environmentId: "env_prod" }];

  it("accepts columns that all belong to the App", () => {
    expect(() => assertMatrixEnvironments(["env_prod", "env_dev"], known)).not.toThrow();
  });

  it("refuses a column outside the App by name", () => {
    expect(() => assertMatrixEnvironments(["env_dev", "env_other"], known)).toThrow(
      "Flags matrix requested 1 Environment(s) outside the App: env_other",
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
    [enabled, cell(true, [25], ["control", "holdout"]), "availability-differs"],
    [enabled, cell(true, [25], ["control"]), "availability-differs"],
    [enabled, cell(true, [25], ["treatment", "control"]), "in-sync"],
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

function cell(
  enabled: boolean,
  rolloutPercentages: number[],
  availableVariantNames: string[] = ["control", "treatment"],
): FlagsMatrixCell {
  return {
    enabled,
    availableVariantCount: availableVariantNames.length,
    availableVariantNames: [...availableVariantNames].sort(),
    rolloutPercentages,
    controllingExperiment: null,
  };
}

function config(environmentId: string, flagId: string, enabled: boolean) {
  return {
    enabled,
    availableVariantNames: ["disabled", "enabled"],
    rollout: null,
    defaultVariant: "disabled",
    targetingRuleRolloutPercentages: [25],
    experiment:
      environmentId === "env_dev" && flagId === "flag_checkout"
        ? { id: "exp_1", name: "Checkout" }
        : null,
  };
}

function catalog(environmentId: string) {
  return {
    ok: true as const,
    status: 200,
    data: {
      readTruncated: true,
      readLimit: 200,
      cursor: null,
      items: [
        definition(
          "flag_checkout",
          "new-checkout",
          config(environmentId, "flag_checkout", environmentId === "env_dev"),
        ),
        definition(
          "flag_banner",
          "banner",
          environmentId === "env_dev" ? config(environmentId, "flag_banner", false) : null,
        ),
      ],
    },
  };
}

function definition(id: string, key: string, flagConfiguration: ReturnType<typeof config> | null) {
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
    ...(flagConfiguration ? { flagConfiguration } : {}),
  };
}
