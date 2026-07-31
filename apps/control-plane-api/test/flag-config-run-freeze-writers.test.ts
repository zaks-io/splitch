import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  promoteFlagConfig,
  setProdPolicy,
  startSeededExperiment,
  token,
} from "../src/config-store-harness-core";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import { confirmPolicy, proposeA, reviewRequest } from "./approval-harness";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

/**
 * The freeze has to hold for EVERY writer that can reach a frozen field, not
 * just the two routes that happen to name it. Both cases below are the
 * reviewer's executed exploits: each one is a fully authorized App admin
 * reaching `flag_configs` / `targeting_rules` in `env_prod` while `run_live` is
 * live, through a door the route-level guard never covered.
 */

let h: Harness;

afterEach(async () => {
  await h.dispose();
});

describe("Promotion into the Environment a live Run owns", () => {
  beforeEach(async () => {
    h = await makeHarness();
    await narrowSeededAvailability(h.d1, ["control", "treatment"]);
    await h.d1
      .prepare(
        "UPDATE flag_configs SET available_variant_names = ? WHERE app_id = ? AND environment_id = ?",
      )
      .bind(JSON.stringify(["control"]), ids.appId, ids.devEnvironmentId)
      .run();
    await startSeededExperiment(h.d1);
  });

  it("refuses to strip a live Run's arm out of the target's servable set", async () => {
    const before = await readProdConfig();

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { availability: ["treatment"] },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RUN_FROZEN",
      details: {
        frozenFields: ["flagConfig.availableVariantNames"],
        currentRunId: ids.liveRunId,
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    });
    const after = await readProdConfig();
    expect(after.availableVariantNames).toEqual(before.availableVariantNames);
    expect(after.version).toBe(before.version);
  });

  it("refuses to replace the target's Targeting Rules", async () => {
    const before = await readProdConfig();

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { targeting: true },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RUN_FROZEN",
      details: { frozenFields: ["flagConfig.targetingRules"] },
    });
    expect((await readProdConfig()).version).toBe(before.version);
  });

  /**
   * Incident control still wins: promoting only `enabled` touches no field the
   * Run owns, so it must go through exactly as it does with no Run at all.
   */
  it("still promotes the kill switch alone", async () => {
    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { enabled: true },
    });

    expect(res.status).toBe(200);
    expect((await readProdConfig()).enabled).toBe(true);
  });

  /**
   * The freeze is per-Environment. `env_dev` carries no Run, so the mirror
   * Promotion — prod into dev — is the same call against an unfrozen target and
   * must succeed.
   */
  it("does not leak the prod Run's freeze into the other direction", async () => {
    const jwt = await token(h.signer);
    const res = await h.app.request(
      `/apps/${ids.appId}/envs/${ids.devEnvironmentId}/flags/${ids.flagId}/promote`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "idempotency-key": "idem_promote_into_dev",
        },
        body: JSON.stringify({
          idempotency_key: "idem_promote_into_dev",
          fromEnvironmentId: ids.environmentId,
          select: { availability: ["treatment"] },
        }),
      },
    );

    expect(res.status).toBe(200);
  });
});

describe("an Approval Request that predates the Run", () => {
  beforeEach(async () => {
    h = await makeHarness();
    await setProdPolicy(h, confirmPolicy);
  });

  /**
   * The reviewer's ATTACK-2, reproduced. The proposal is minted legitimately
   * while nothing is running, so the route guard that refuses ahead of the
   * Policy gate never sees it. Starting a Run does not bump the Flag
   * Configuration version either, so the staleness check cannot catch it. The
   * refusal has to live where the write does.
   */
  it("refuses approve_and_apply once a Run owns the field", async () => {
    const requestId = await proposeA(h);
    const before = await readProdConfig();

    await startSeededExperiment(h.d1);
    const res = await reviewRequest(h, requestId, "idem_review_frozen");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RUN_FROZEN",
      details: {
        frozenFields: ["flagConfig.availableVariantNames"],
        currentRunId: ids.liveRunId,
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    });
    const after = await readProdConfig();
    expect(after.availableVariantNames).toEqual(before.availableVariantNames);
    expect(after.version).toBe(before.version);
  });

  /**
   * It must not stay pending. A Request that can only become applicable the
   * moment the Run ends is a delayed write nobody re-authorized — the same
   * disguised default the direct refusal exists to prevent (ADR-0036). It
   * resolves terminally, so the remedy is to re-propose against the state the
   * Run actually leaves behind.
   */
  it("resolves the Request terminally instead of leaving it approvable", async () => {
    const requestId = await proposeA(h);
    await startSeededExperiment(h.d1);

    await reviewRequest(h, requestId, "idem_review_frozen");

    const stored = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    expect(stored?.status).toBe("stale");
    expect(stored?.resolvedAt).not.toBeNull();
  });

  it("keeps refusing a second Review rather than applying on retry", async () => {
    const requestId = await proposeA(h);
    await startSeededExperiment(h.d1);
    await reviewRequest(h, requestId, "idem_review_frozen");

    const retry = await reviewRequest(h, requestId, "idem_review_frozen_retry");

    expect(retry.status).toBe(409);
    expect((await readProdConfig()).version).toBe(1);
  });

  /**
   * The Approval path is not a second freeze rule. With no Run live the exact
   * same Request applies, which is what proves the refusal above is the Run and
   * not the Approval machinery refusing everything.
   */
  it("applies the same Request while nothing is running", async () => {
    const requestId = await proposeA(h);

    const res = await reviewRequest(h, requestId, "idem_review_free");

    expect(res.status).toBe(200);
    expect((await readProdConfig()).availableVariantNames).toEqual(["control"]);
  });
});

async function readProdConfig(): Promise<{
  availableVariantNames: string[];
  enabled: boolean;
  version: number;
}> {
  const scope = envScope(ids.appId, ids.environmentId);
  const row = await h.repo.flags.getFlagConfig(scope, ids.flagId);
  if (!row) throw new Error("readProdConfig: no Flag Configuration");
  return {
    availableVariantNames: JSON.parse(row.availableVariantNames) as string[],
    enabled: row.enabled,
    version: row.version,
  };
}
