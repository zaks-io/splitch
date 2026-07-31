import { CURRENT_KV_SCHEMA_VERSION, flagConfigKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  kvJson,
  patchFlagConfig,
  promoteFlagConfig,
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

async function storedRollout(environmentId = ids.environmentId) {
  const config = await h.repo.flags.getFlagConfig(envScope(ids.appId, environmentId), ids.flagId);
  return config?.rollout === null || config?.rollout === undefined
    ? null
    : (JSON.parse(config.rollout) as { percentage: number; salt: string });
}

describe("baseline rollout on Flag Configuration", () => {
  it("mints a salt server-side when the baseline is first set", async () => {
    const res = await patchFlagConfig(h, { rollout: { percentage: 10 } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      approvalRequest: null,
      config: {
        rollout: { percentage: 10, salt: expect.stringMatching(/^[0-9a-f]{16}$/) },
      },
    });
  });

  it("KEEPS the salt byte-identical across percentage changes", async () => {
    // The headline invariant: the salt IS the bucket assignment, so reminting it
    // on a percentage change would silently reshuffle who is in the rollout.
    await patchFlagConfig(h, { rollout: { percentage: 10 } });
    const minted = await storedRollout();
    expect(minted?.salt).toEqual(expect.any(String));

    for (const percentage of [25, 60]) {
      const res = await patchFlagConfig(h, { rollout: { percentage } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        approvalRequest: null,
        config: { rollout: { percentage, salt: minted?.salt } },
      });
    }

    expect((await storedRollout())?.salt).toBe(minted?.salt);
  });

  it("preserves the baseline when the patch omits `rollout` entirely", async () => {
    await patchFlagConfig(h, { rollout: { percentage: 40 } });
    const before = await storedRollout();

    const res = await patchFlagConfig(h, { enabled: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      approvalRequest: null,
      config: { enabled: true, rollout: before },
    });
  });

  it("clears the baseline on an explicit null, then mints a FRESH salt on re-establish", async () => {
    await patchFlagConfig(h, { rollout: { percentage: 10 } });
    const first = await storedRollout();

    const cleared = await patchFlagConfig(h, { rollout: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      approvalRequest: null,
      config: { rollout: null },
    });
    expect(await storedRollout()).toBeNull();

    // Clearing is explicit and visible, so the operator has already accepted
    // losing the old cohort — a fresh salt here is honest, not silent.
    await patchFlagConfig(h, { rollout: { percentage: 10 } });
    expect((await storedRollout())?.salt).not.toBe(first?.salt);
  });

  it("publishes the baseline to the data plane's KV blob", async () => {
    await patchFlagConfig(h, { rollout: { percentage: 30 } });

    const envelope = await kvJson(
      h.kv,
      flagConfigKey(ids.appId, ids.environmentId, "checkout-redesign"),
    );

    expect(envelope).toMatchObject({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: { rollout: { percentage: 30, salt: (await storedRollout())?.salt } },
    });
  });

  it("REJECTS a caller-supplied salt — the salt is never the caller's to choose", async () => {
    const res = await patchFlagConfig(h, {
      rollout: { percentage: 10, salt: "attacker-chosen" },
    });

    expect(res.status).toBe(400);
    expect(await storedRollout()).toBeNull();
  });

  it.each([-1, 101])("rejects an out-of-range percentage (%s)", async (percentage) => {
    const res = await patchFlagConfig(h, { rollout: { percentage } });

    expect(res.status).toBe(400);
    expect(await storedRollout()).toBeNull();
  });

  it("gates a baseline change behind the Environment Policy's rollout gate", async () => {
    await setProdPolicy(h, {
      variantAvailability: "allow",
      targetingRolloutValue: "confirm",
      enabledState: "allow",
      startExperimentRun: "allow",
    });

    const blocked = await patchFlagConfig(h, { rollout: { percentage: 10 } });
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
    expect(await storedRollout()).toBeNull();

    const confirmed = await patchFlagConfig(h, {
      rollout: { percentage: 10 },
      review: { action: "approve_and_apply" },
    });
    expect(confirmed.status).toBe(200);
  });
});

describe("baseline rollout under Promotion", () => {
  it("moves the source percentage but KEEPS the target's own salt", async () => {
    // Each Environment's cohort is its own: adopting the source salt would
    // reshuffle every bucketed Entity in the target.
    const dev = envScope(ids.appId, ids.devEnvironmentId);
    await h.repo.flags.updateFlagConfig(dev, ids.flagId, {
      rollout: JSON.stringify({ percentage: 75, salt: "dev-salt-abcdef01" }),
    });
    await patchFlagConfig(h, { rollout: { percentage: 5 } });
    const targetSaltBefore = (await storedRollout())?.salt;

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { rollout: true },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      config: { rollout: { percentage: 75, salt: targetSaltBefore } },
    });
    expect((await storedRollout())?.salt).not.toBe("dev-salt-abcdef01");
  });

  it("leaves the target baseline untouched when `rollout` is not selected", async () => {
    const setup = await patchFlagConfig(h, { rollout: { percentage: 5 } });
    expect(setup.status).toBe(200);
    const before = await storedRollout();
    // Without this, a failed setup leaves `before` null and the final equality
    // passes vacuously, proving nothing about preservation.
    expect(before).not.toBeNull();

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { enabled: true },
    });

    expect(res.status).toBe(200);
    expect(await storedRollout()).toEqual(before);
  });

  it("mints a salt for a target that had no baseline of its own", async () => {
    const dev = envScope(ids.appId, ids.devEnvironmentId);
    await h.repo.flags.updateFlagConfig(dev, ids.flagId, {
      rollout: JSON.stringify({ percentage: 20, salt: "dev-salt-abcdef01" }),
    });

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { rollout: true },
    });

    expect(res.status).toBe(200);
    const promoted = await storedRollout();
    expect(promoted?.percentage).toBe(20);
    expect(promoted?.salt).toMatch(/^[0-9a-f]{16}$/);
    expect(promoted?.salt).not.toBe("dev-salt-abcdef01");
  });
});
