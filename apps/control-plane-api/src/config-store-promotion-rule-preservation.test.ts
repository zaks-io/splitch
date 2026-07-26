import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  makeHarness,
  promoteFlagConfig,
  replaceTargetingRules,
} from "./config-store-test-harness";

/**
 * SPL-170 redefined `select.rollout` to mean the config-level BASELINE, which
 * lives on flag_configs and carries no Targeting Rules. A rollout-only promotion
 * must therefore leave the target's rules physically untouched.
 *
 * The rules are replaced by a DELETE + re-INSERT that re-stamps `createdAt`, so
 * a wrongly-routed promotion round-trips the rule CONTENT unchanged and is
 * invisible to any assertion on the rule set. Worse, the harness clock is frozen
 * at NOW, so a rewrite lands the same timestamp that is already stored. These
 * tests therefore BACKDATE the row first: only then does a rewrite show up, as
 * `createdAt` jumping forward to the store's clock.
 */

const BACKDATED = "2020-01-01T00:00:00.000Z";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.dispose();
});

async function seedBackdatedRule(): Promise<void> {
  const res = await replaceTargetingRules(h, {
    targetingRules: [
      {
        id: "rule_preserved",
        flagId: ids.flagId,
        priority: 0,
        conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
        variantId: ids.treatmentVariantId,
      },
    ],
  });
  expect(res.status).toBe(200);
  await h.d1
    .prepare("UPDATE targeting_rules SET created_at = ?, updated_at = ? WHERE id = ?")
    .bind(BACKDATED, BACKDATED, "rule_preserved")
    .run();
}

async function ruleStamps(): Promise<Array<{ id: string; created_at: string }>> {
  const result = await h.d1
    .prepare("SELECT id, created_at FROM targeting_rules WHERE flag_id = ? ORDER BY id")
    .bind(ids.flagId)
    .all();
  return result.results as Array<{ id: string; created_at: string }>;
}

async function seedDevBaseline(): Promise<void> {
  await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.devEnvironmentId), ids.flagId, {
    rollout: JSON.stringify({ percentage: 20, salt: "dev-salt-abcdef01" }),
  });
}

describe("promotion leaves Targeting Rules alone unless they were selected", () => {
  it("does not re-stamp the target's rules on a rollout-only promotion", async () => {
    await seedBackdatedRule();
    await seedDevBaseline();

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { rollout: true },
    });

    expect(res.status).toBe(200);
    expect(await ruleStamps()).toContainEqual({ id: "rule_preserved", created_at: BACKDATED });
  });

  it("does not re-stamp the target's rules on an availability-only promotion", async () => {
    await seedBackdatedRule();

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { availability: ["treatment"] },
    });

    expect(res.status).toBe(200);
    expect(await ruleStamps()).toContainEqual({ id: "rule_preserved", created_at: BACKDATED });
  });

  it("still promotes the baseline itself on a rollout-only promotion", async () => {
    // The rules staying put must not come at the cost of the write being skipped.
    await seedBackdatedRule();
    await seedDevBaseline();

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { rollout: true },
    });

    expect(res.status).toBe(200);
    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(JSON.parse(config?.rollout ?? "null")).toMatchObject({ percentage: 20 });
  });
});
