import type { TargetingRule } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  replaceTargetingRules,
  setProdPolicy,
} from "../src/config-store-harness-core";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

const confirmPolicy = {
  variantAvailability: "confirm",
  targetingRolloutValue: "confirm",
  enabledState: "confirm",
  startExperimentRun: "confirm",
} as const;

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("Targeting Rule rollout salts", () => {
  it("mints a salt when a new percentage-bearing rule omits one", async () => {
    const response = await replaceTargetingRules(h, {
      targetingRules: [rule({ percentage: 25 })],
    });

    expect(response.status).toBe(200);
    expect((await responseRule(response)).percentageRollout).toEqual({
      percentage: 25,
      salt: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it("preserves the persisted salt across an unrelated rule edit", async () => {
    const created = await replaceTargetingRules(h, {
      targetingRules: [rule({ percentage: 25 })],
    });
    const original = await responseRule(created);
    const originalRollout = original.percentageRollout;
    if (!originalRollout) throw new Error("expected a percentage rollout");
    expect(originalRollout.salt).toMatch(/^[0-9a-f]{16}$/);

    const edited = await replaceTargetingRules(h, {
      targetingRules: [
        {
          ...rule(originalRollout),
          conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
        },
      ],
    });

    expect(edited.status).toBe(200);
    expect((await responseRule(edited)).percentageRollout?.salt).toBe(originalRollout.salt);
  });

  it("rejects a caller-supplied salt for a new rule", async () => {
    const response = await replaceTargetingRules(h, {
      targetingRules: [rule({ percentage: 25, salt: "caller-chosen" })],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [
          {
            path: ["body", "targetingRules", "0", "percentageRollout", "salt"],
            message: "Targeting Rule bucketing salt is server-owned",
          },
        ],
      },
    });
  });

  it("rejects replacing an existing server-owned salt", async () => {
    const created = await replaceTargetingRules(h, {
      targetingRules: [rule({ percentage: 25 })],
    });
    expect(created.status).toBe(200);

    const response = await replaceTargetingRules(h, {
      targetingRules: [rule({ percentage: 25, salt: "caller-replacement" })],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("mints once in the Approval preview and applies that proposed salt", async () => {
    await setProdPolicy(h, confirmPolicy);
    const response = await replaceTargetingRules(h, {
      targetingRules: [rule({ percentage: 40 })],
      review: { action: "approve_and_apply" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approvalRequest: { status: string };
      targetingRules: TargetingRule[];
    };
    expect(body.approvalRequest.status).toBe("applied");
    expect(body.targetingRules[0]?.percentageRollout).toEqual({
      percentage: 40,
      salt: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });
});

function rule(percentageRollout: { percentage: number; salt?: string }) {
  return {
    id: "rule_percentage",
    flagId: ids.flagId,
    priority: 0,
    conditions: [{ attribute: "plan", operator: "eq" as const, value: "pro" }],
    variantId: ids.treatmentVariantId,
    percentageRollout,
  };
}

async function responseRule(response: Response): Promise<TargetingRule> {
  const body = (await response.json()) as { targetingRules: TargetingRule[] };
  const first = body.targetingRules[0];
  if (!first) throw new Error("expected a Targeting Rule response");
  return first;
}
