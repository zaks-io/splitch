import { CURRENT_KV_SCHEMA_VERSION, flagConfigKey } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
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
  // The fixture ships `[]` (never narrowed), matching `ensureInitialFlagConfig`.
  // This suite asserts on the available-Variant list itself, so it narrows
  // explicitly instead of leaning on a fixture default.
  await narrowSeededAvailability(h.d1);
});

afterEach(async () => {
  await h.dispose();
});

describe("Promotion source Environment validation", () => {
  it("rejects a source Environment owned by another App without touching the target", async () => {
    const foreignEnvironmentId = "env_other_app_source";
    await h.repo.identity.environments.insert(appScope(ids.otherAppId), {
      id: foreignEnvironmentId,
      appId: ids.otherAppId,
      key: "distinctive-source",
      name: "Distinctive source",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await h.repo.flags.flagConfigs.insert(envScope(ids.otherAppId, foreignEnvironmentId), {
      id: "flag_config_other_app_source",
      appId: ids.otherAppId,
      environmentId: foreignEnvironmentId,
      flagId: ids.flagId,
      enabled: true,
      availableVariantNames: JSON.stringify(["treatment"]),
      defaultVariantId: ids.treatmentVariantId,
      rollout: JSON.stringify({ percentage: 73, salt: "distinctive-foreign-salt" }),
      createdAt: NOW,
      updatedAt: "2026-07-02T03:04:05.000Z",
    });
    const before = await targetConfigBytes();

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: foreignEnvironmentId,
      select: { enabled: true, availability: ["treatment"], rollout: true },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [
          {
            path: ["fromEnvironmentId"],
            message: expect.stringContaining(foreignEnvironmentId),
          },
        ],
      },
    });
    expect(await targetConfigBytes()).toBe(before);
    expect(h.nudges).toEqual([]);
  });

  it("rejects promoting an Environment into itself as a caller error", async () => {
    const before = await targetConfigBytes();

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.environmentId,
      select: { enabled: true },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [
          {
            path: ["fromEnvironmentId"],
            message: expect.stringContaining("must differ"),
          },
        ],
      },
    });
    expect(await targetConfigBytes()).toBe(before);
  });
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
      code: "APPROVAL_REVIEW_REQUIRED",
      details: {
        approvalRequestId: expect.stringMatching(/^apr_/),
        policyContexts: [
          expect.objectContaining({
            environmentId: ids.environmentId,
            changeTypes: ["enabled_state"],
          }),
        ],
        recommendedAction: "REVIEW_APPROVAL_REQUEST",
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
    const approvedBody = await approved.json();

    const approvedReplay = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { enabled: true },
      review: { action: "approve_and_apply" },
    });
    expect(approvedReplay.status).toBe(200);
    expect(await approvedReplay.json()).toEqual(approvedBody);
  });

  it("replays a pending rollout Promotion with its deterministic target salt", async () => {
    await setProdPolicy(h, confirmPolicy);
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.devEnvironmentId), ids.flagId, {
      rollout: JSON.stringify({ percentage: 25, salt: "source-salt" }),
      updatedAt: NOW,
    });

    const first = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { rollout: true },
    });
    const replay = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { rollout: true },
    });

    expect(first.status).toBe(409);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual(await first.json());
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

async function targetConfigBytes(): Promise<string> {
  const scope = envScope(ids.appId, ids.environmentId);
  const [config, targetingRules] = await Promise.all([
    h.repo.flags.getFlagConfig(scope, ids.flagId),
    h.repo.flags.listTargetingRules(scope, ids.flagId),
  ]);
  return JSON.stringify({ config, targetingRules });
}

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
