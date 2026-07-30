import { CURRENT_KV_SCHEMA_VERSION, flagConfigKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  NOW,
  promoteFlagConfig,
  replaceTargetingRules,
  setProdPolicy,
} from "../src/config-store-harness-core";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

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

    const legacyConfirm = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { enabled: true },
      confirm: true,
    });
    expect(legacyConfirm.status).toBe(400);
    expect(await legacyConfirm.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    const approved = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { enabled: true },
      review: { action: "approve_and_apply" },
    });
    expect(approved.status).toBe(200);
  });

  /**
   * `select.rollout` moves the config-level baseline and NOTHING else. It used to
   * also graft each source rule's percentage onto the target rule sharing its
   * `priority`, which is a sort key rather than an identity: here Dev's rule is
   * `plan == pro -> treatment @ 25%` and Prod's is `country == US -> control`,
   * unrelated rules that merely both sit at priority 0. Prod's US rule must keep
   * its own (absent) percentage.
   */
  it("promotes the baseline without touching target Targeting Rules", async () => {
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
    const body = (await res.json()) as {
      config: { version: number; targetingRules: { percentageRollout?: unknown }[] };
    };
    expect(body).toMatchObject({
      config: {
        version: 2,
        targetingRules: [
          {
            id: "rule_checkout_prod_control",
            variantId: ids.controlVariantId,
            conditions: [{ attribute: "country", operator: "eq", value: "US" }],
          },
        ],
      },
    });
    expect(body.config.targetingRules[0]?.percentageRollout).toBeUndefined();
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
