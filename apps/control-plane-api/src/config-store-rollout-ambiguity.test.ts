import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  makeHarness,
  NOW,
  patchFlagConfig,
  promoteFlagConfig,
} from "./config-store-test-harness";

/**
 * A baseline rollout rolls traffic away from the Default Variant and INTO the one
 * other available Variant. With zero or two-plus non-Default Variants available,
 * the destination is unknowable, so the write is rejected at the operator's
 * keystroke rather than left for production traffic to discover (ADR-0036).
 */

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.dispose();
});

async function addThirdVariant(): Promise<void> {
  await h.repo.flags.addVariant(appScope(ids.appId), ids.flagId, {
    id: "var_holdback",
    name: "holdback",
    value: JSON.stringify("hold"),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function storedRollout(): Promise<unknown> {
  const config = await h.repo.flags.getFlagConfig(
    envScope(ids.appId, ids.environmentId),
    ids.flagId,
  );
  return config?.rollout ?? null;
}

async function storedAvailability(): Promise<string[]> {
  const config = await h.repo.flags.getFlagConfig(
    envScope(ids.appId, ids.environmentId),
    ids.flagId,
  );
  return JSON.parse(config?.availableVariantNames ?? "[]") as string[];
}

describe("baseline rollout ambiguity gate", () => {
  it("rejects a baseline when two non-Default Variants are available", async () => {
    await addThirdVariant();
    await patchFlagConfig(h, { availableVariantNames: ["control", "treatment", "holdback"] });

    const res = await patchFlagConfig(h, { rollout: { percentage: 10 } });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: ["rollout"] }] },
    });
    expect(await storedRollout()).toBeNull();
  });

  it("rejects a baseline when only the Default Variant is available", async () => {
    await patchFlagConfig(h, { availableVariantNames: ["control"] });

    const res = await patchFlagConfig(h, { rollout: { percentage: 10 } });

    expect(res.status).toBe(400);
    expect(await storedRollout()).toBeNull();
  });

  it("rejects a baseline and a widening availability set in the SAME write", async () => {
    await addThirdVariant();

    const res = await patchFlagConfig(h, {
      availableVariantNames: ["control", "treatment", "holdback"],
      rollout: { percentage: 10 },
    });

    expect(res.status).toBe(400);
    expect(await storedRollout()).toBeNull();
  });

  it("accepts a baseline with exactly one non-Default Variant available", async () => {
    const res = await patchFlagConfig(h, { rollout: { percentage: 10 } });

    expect(res.status).toBe(200);
    expect(await storedRollout()).not.toBeNull();
  });

  it("still allows CLEARING a baseline while availability is ambiguous", async () => {
    await patchFlagConfig(h, { rollout: { percentage: 10 } });
    await addThirdVariant();
    await patchFlagConfig(h, { availableVariantNames: ["control", "treatment", "holdback"] });

    const res = await patchFlagConfig(h, { rollout: null });

    expect(res.status).toBe(200);
    expect(await storedRollout()).toBeNull();
  });

  it("rejects WIDENING availability out from under an existing baseline", async () => {
    // The other direction of the same stranding: the caller never mentions
    // `rollout`, but the write would leave the stored baseline unresolvable.
    await patchFlagConfig(h, { rollout: { percentage: 25 } });
    await addThirdVariant();

    const res = await patchFlagConfig(h, {
      availableVariantNames: ["control", "treatment", "holdback"],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: ["rollout"] }] },
    });
    expect(await storedAvailability()).toEqual(["control", "treatment"]);
  });

  it("allows widening availability once the baseline is cleared in the same write", async () => {
    await patchFlagConfig(h, { rollout: { percentage: 25 } });
    await addThirdVariant();

    const res = await patchFlagConfig(h, {
      availableVariantNames: ["control", "treatment", "holdback"],
      rollout: null,
    });

    expect(res.status).toBe(200);
    expect(await storedRollout()).toBeNull();
    expect(await storedAvailability()).toEqual(["control", "treatment", "holdback"]);
  });

  it("rejects PROMOTING availability that strands the target's existing baseline", async () => {
    // `select.rollout` is NOT set, so the baseline is not moving — but the
    // availability landing in the same call would leave it unresolvable.
    await patchFlagConfig(h, { rollout: { percentage: 25 } });
    await addThirdVariant();
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.devEnvironmentId), ids.flagId, {
      availableVariantNames: JSON.stringify(["control", "treatment", "holdback"]),
    });

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { availability: ["holdback"] },
    });

    expect(res.status).toBe(400);
    expect(await storedAvailability()).toEqual(["control", "treatment"]);
  });

  it("rejects PROMOTING a baseline into an ambiguous target", async () => {
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.devEnvironmentId), ids.flagId, {
      rollout: JSON.stringify({ percentage: 20, salt: "dev-salt-abcdef01" }),
    });
    await addThirdVariant();
    await patchFlagConfig(h, { availableVariantNames: ["control", "treatment", "holdback"] });

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { rollout: true },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: ["rollout"] }] },
    });
    expect(await storedRollout()).toBeNull();
  });

  it("judges promotion ambiguity against the availability the SAME call is landing", async () => {
    // Target is unambiguous today, but this promotion widens it to three
    // available Variants in the same write, so the baseline has nowhere to land.
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.devEnvironmentId), ids.flagId, {
      rollout: JSON.stringify({ percentage: 20, salt: "dev-salt-abcdef01" }),
      availableVariantNames: JSON.stringify(["control", "treatment", "holdback"]),
    });
    await addThirdVariant();

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { availability: ["holdback"], rollout: true },
    });

    expect(res.status).toBe(400);
    expect(await storedRollout()).toBeNull();
  });
});
