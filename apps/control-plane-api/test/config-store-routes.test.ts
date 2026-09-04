import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import {
  type Harness,
  ids,
  patchFlagConfig,
  promoteFlagConfig,
  replaceTargetingRules,
  setProdPolicy,
} from "../src/config-store-harness-core";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

let h: Harness;

const confirmPolicy = {
  variantAvailability: "confirm",
  targetingRolloutValue: "confirm",
  enabledState: "confirm",
  startExperimentRun: "confirm",
} as const;

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

describe("flag configuration and promotion routes", () => {
  it("uses the canonical review field for a Policy-gated Targeting Rules replacement", async () => {
    await setProdPolicy(h, confirmPolicy);
    const body = {
      targetingRules: [
        {
          id: "rule_prod_treatment",
          flagId: ids.flagId,
          priority: 0,
          conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
          variantId: ids.treatmentVariantId,
        },
      ],
    };

    const blocked = await replaceTargetingRules(h, body);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      code: "APPROVAL_REVIEW_REQUIRED",
      details: {
        approvalRequestId: expect.stringMatching(/^apr_/),
        policyContexts: [
          expect.objectContaining({
            environmentId: ids.environmentId,
            changeTypes: ["targeting_rollout_value"],
          }),
        ],
      },
    });

    const legacyConfirm = await replaceTargetingRules(h, { ...body, confirm: true });
    expect(legacyConfirm.status).toBe(400);
    expect(await legacyConfirm.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    const approved = await replaceTargetingRules(h, {
      ...body,
      review: { action: "approve_and_apply" },
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      approvalRequest: { status: "applied" },
      version: 2,
      targetingRules: [
        expect.objectContaining({
          id: "rule_prod_treatment",
          variantId: ids.treatmentVariantId,
        }),
      ],
    });
    expect(h.events.slice(0, 2)).toEqual(["d1-before-kv:false", "kv:flag"]);
    expect(h.events.at(-1)).toBe("broadcast");
  });

  it("returns APPROVAL_REVIEW_REQUIRED for a Policy-gated PATCH without review", async () => {
    await setProdPolicy(h, confirmPolicy);

    const res = await patchFlagConfig(h, { availableVariantNames: ["control"] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "APPROVAL_REVIEW_REQUIRED",
      details: {
        approvalRequestId: expect.stringMatching(/^apr_/),
        policyContexts: [
          expect.objectContaining({
            environmentId: ids.environmentId,
            changeTypes: ["variant_availability"],
          }),
        ],
        recommendedAction: "REVIEW_APPROVAL_REQUEST",
      },
    });
    expect(h.nudges).toEqual([]);
  });

  it("accepts enabled-off as an ungated kill switch", async () => {
    await setProdPolicy(h, confirmPolicy);

    const legacyConfirm = await patchFlagConfig(h, { enabled: true, confirm: true });
    expect(legacyConfirm.status).toBe(400);
    expect(await legacyConfirm.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    const enable = await patchFlagConfig(h, {
      enabled: true,
      review: { action: "approve_and_apply" },
    });
    expect(enable.status).toBe(200);

    const disable = await patchFlagConfig(h, { enabled: false }, "idem_kill_switch_disable");

    expect(disable.status).toBe(200);
    expect(await disable.json()).toMatchObject({
      approvalRequest: null,
      enabled: false,
    });
  });

  it("promotes selected config field-groups and returns a before/after diff", async () => {
    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { targeting: true, enabled: true },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      flagId: ids.flagId,
      environmentId: ids.environmentId,
      enabled: true,
      targetingRules: [
        expect.objectContaining({
          variantId: ids.treatmentVariantId,
        }),
      ],
      diff: {
        before: { enabled: false, targetingRules: [] },
        after: {
          enabled: true,
          targetingRules: [
            expect.objectContaining({
              variantId: ids.treatmentVariantId,
            }),
          ],
        },
      },
    });
    expect(h.events.slice(0, 2)).toEqual(["d1-before-kv:true", "kv:flag"]);
    expect(h.events.at(-1)).toBe("broadcast");
  });

  it("rejects promoted Targeting Rules that route to an unavailable Variant", async () => {
    const narrow = await patchFlagConfig(h, { availableVariantNames: ["control"] });
    expect(narrow.status).toBe(200);
    const nudgeCount = h.nudges.length;

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { targeting: true },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "VARIANT_NOT_AVAILABLE",
      details: {
        flagId: ids.flagId,
        environmentId: ids.environmentId,
        missingVariants: ["treatment"],
        recommendedAction: "ADD_VARIANT_TO_ENV",
      },
    });
    expect(h.nudges).toHaveLength(nudgeCount);
  });
});

describe("config store route harness", () => {
  it("keeps the explicit helper idempotency key in the request body", async () => {
    await setProdPolicy(h, confirmPolicy);
    const idempotencyKey = "idem_explicit_config_update";

    const first = await patchFlagConfig(
      h,
      { availableVariantNames: ["control"], idempotency_key: "ignored_first" },
      idempotencyKey,
    );
    const replay = await patchFlagConfig(
      h,
      { availableVariantNames: ["control"], idempotency_key: "ignored_second" },
      idempotencyKey,
    );

    expect(first.status).toBe(409);
    expect(replay.status).toBe(409);
    const firstBody = (await first.json()) as { details: { approvalRequestId: string } };
    const replayBody = (await replay.json()) as { details: { approvalRequestId: string } };
    expect(replayBody.details.approvalRequestId).toBe(firstBody.details.approvalRequestId);
  });
});
