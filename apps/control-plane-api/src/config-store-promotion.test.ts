import { CURRENT_KV_SCHEMA_VERSION, flagConfigKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  makeHarness,
  NOW,
  promoteFlagConfig,
  replaceTargetingRules,
  setProdPolicy,
} from "./config-store-test-harness.js";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("flag configuration Promotion routes", () => {
  const confirmPolicy = {
    variantAvailability: "confirm",
    targetingRolloutValue: "confirm",
    enabledState: "confirm",
    startExperimentRun: "confirm",
  } as const;

  it("requires enabled-state confirmation from D1 source when KV is stale", async () => {
    await setProdPolicy(h, confirmPolicy);
    await h.kv.put(
      flagConfigKey(ids.appId, ids.devEnvironmentId, ids.flagKey),
      JSON.stringify({
        schemaVersion: CURRENT_KV_SCHEMA_VERSION,
        data: {
          id: ids.flagId,
          key: ids.flagKey,
          environmentId: ids.devEnvironmentId,
          experimentId: null,
          enabled: false,
          defaultVariantId: ids.controlVariantId,
          variants: [
            { id: ids.controlVariantId, name: "control", value: "off" },
            { id: ids.treatmentVariantId, name: "treatment", value: "on" },
          ],
          availableVariantNames: ["control", "treatment"],
          targetingRules: [],
          updatedAt: NOW,
        },
      }),
    );

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { enabled: true },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      details: {
        gate: "enabled_state",
        environmentId: ids.environmentId,
        attemptedOp: "PROMOTE_FLAG_CONFIG",
        recommendedAction: "RETRY_WITH_CONFIRMATION",
      },
    });
    expect(h.nudges).toEqual([]);
  });

  it("promotes rollout without replacing target Targeting Rule fields", async () => {
    await h.repo.flags.targetingRules.insert(envScope(ids.appId, ids.environmentId), {
      id: "rule_checkout_prod_control",
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      priority: 0,
      conditions: JSON.stringify([{ attribute: "country", operator: "eq", value: "US" }]),
      variantId: ids.controlVariantId,
      percentageRollout: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { rollout: true },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      config: {
        version: 2,
        targetingRules: [
          {
            id: "rule_checkout_prod_control",
            variantId: ids.controlVariantId,
            conditions: [{ attribute: "country", operator: "eq", value: "US" }],
            percentageRollout: { percentage: 25, salt: "dev-rollout" },
          },
        ],
      },
      diff: {
        before: {
          targetingRules: [
            expect.objectContaining({
              id: "rule_checkout_prod_control",
              variantId: ids.controlVariantId,
              conditions: [{ attribute: "country", operator: "eq", value: "US" }],
            }),
          ],
        },
        after: {
          targetingRules: [
            expect.objectContaining({
              id: "rule_checkout_prod_control",
              percentageRollout: { percentage: 25, salt: "dev-rollout" },
            }),
          ],
        },
      },
    });
    expect(h.events.slice(0, 2)).toEqual(["d1-before-kv:false", "kv:flag"]);
    expect(h.events.at(-1)).toBe("broadcast");
  });
});

describe("Flag Configuration Targeting Rule validation", () => {
  it("rejects Targeting Rules whose variantId is not a catalog ID", async () => {
    const res = await replaceTargetingRules(h, {
      targetingRules: [
        {
          id: "rule_control_name_instead_of_id",
          flagId: ids.flagId,
          priority: 0,
          conditions: [{ attribute: "plan", operator: "eq", value: "free" }],
          variantId: "control",
        },
      ],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "VARIANT_NOT_AVAILABLE",
      details: {
        flagId: ids.flagId,
        environmentId: ids.environmentId,
        missingVariants: ["control"],
        recommendedAction: "ADD_VARIANT_TO_ENV",
      },
    });
    expect(h.nudges).toEqual([]);
  });
});
