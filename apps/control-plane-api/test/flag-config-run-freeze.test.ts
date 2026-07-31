import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  NOW,
  patchFlagConfig,
  replaceTargetingRules,
  setProdPolicy,
  startSeededExperiment,
  token,
} from "../src/config-store-harness-core";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
  await startSeededExperiment(h.d1);
});

afterEach(async () => {
  await h.dispose();
});

/**
 * The Experiment lock is a WORKER invariant, not a panel affordance.
 *
 * Every test here is the forced call an operator or agent makes when they skip the
 * screen: a direct, fully authorized request from the legitimate App admin against
 * a Flag whose Environment has a live Run. `env_prod` in this fixture carries a
 * running Experiment (`exp_checkout`) with a live Run (`run_live`), so these are
 * the real conditions, not a mocked lock.
 *
 * Delete the guard in `flag-config-run-freeze.ts` and this file goes red. That is
 * the whole point: the previous coverage only asserted that the panel omits a
 * control, which stayed green with no enforcement behind it at all.
 */
describe("Flag Configuration under a live Run", () => {
  it("refuses to narrow availability, naming the Run and a remedy the operator can perform", async () => {
    const res = await patchFlagConfig(h, { availableVariantNames: ["control"] });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details: Record<string, unknown>;
    };
    expect(body.code).toBe("RUN_FROZEN");
    // Self-explaining: the refusal names the Run that owns the field, so the
    // operator does not have to go looking for what stopped them (ADR-0036).
    expect(body.message).toContain(ids.liveRunId);
    expect(body.details).toMatchObject({
      frozenFields: ["flagConfig.availableVariantNames"],
      currentRunId: ids.liveRunId,
      recommendedAction: "END_RUNNING_RUN_FIRST",
    });
  });

  it("refuses to replace Targeting Rules", async () => {
    const res = await replaceTargetingRules(h, { targetingRules: [] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RUN_FROZEN",
      details: {
        frozenFields: ["flagConfig.targetingRules"],
        currentRunId: ids.liveRunId,
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    });
  });

  it("refuses a baseline rollout that a live Run would make inert", async () => {
    const res = await patchFlagConfig(h, { rollout: { percentage: 25 } });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RUN_FROZEN",
      details: { frozenFields: ["flagConfig.rollout"] },
    });
  });

  /**
   * The reviewer's exact escalation, reproduced. Under a `confirm` Policy the
   * refusal used to be `APPROVAL_REVIEW_REQUIRED`, whose Approval Request could
   * then be self-reviewed with `approve_and_apply` straight through the "lock".
   * The Run refusal must therefore fire BEFORE the Policy gate: there must be no
   * Approval Request to review, because the change can never legitimately land.
   */
  it("refuses ahead of the Policy gate, so no Approval Request is ever recorded", async () => {
    await setProdPolicy(h, {
      variantAvailability: "confirm",
      targetingRolloutValue: "confirm",
      enabledState: "confirm",
      startExperimentRun: "confirm",
    });

    const res = await patchFlagConfig(h, { availableVariantNames: ["control"] });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; details: Record<string, unknown> };
    expect(body.code).toBe("RUN_FROZEN");
    expect(body.code).not.toBe("APPROVAL_REVIEW_REQUIRED");
    expect(body.details.approvalRequestId).toBeUndefined();
    // Nothing pending: the write left no proposal behind for a reviewer to
    // approve into a change the Run forbids.
    expect(await countApprovalRequests()).toBe(0);
  });

  it("leaves the Configuration exactly as the Worker held it", async () => {
    const before = await readConfig();

    await patchFlagConfig(h, { availableVariantNames: ["control"] });

    const after = await readConfig();
    expect(after.availableVariantNames).toEqual(before.availableVariantNames);
    expect(after.version).toBe(before.version);
  });

  /**
   * Incident control outranks the Run. A Flag owned by a running Experiment must
   * still be turnable off, or an operator is locked out of the one action an
   * outage requires (ADR-0029, flag-editing-ux.md "Kill switch is always exempt").
   */
  it("never freezes the kill switch", async () => {
    const res = await patchFlagConfig(h, { enabled: false });

    expect(res.status).toBe(200);
    expect((await readConfig()).enabled).toBe(false);
  });

  it("applies the same edits freely once no Run is live", async () => {
    await endTheRun();

    const res = await patchFlagConfig(h, { availableVariantNames: ["control"] });

    expect(res.status).toBe(200);
    expect((await readConfig()).availableVariantNames).toEqual(["control"]);
  });

  /**
   * The freeze is per-Environment because a Run is. `env_dev` carries no live Run,
   * so the byte-identical call prod refuses applies here.
   */
  it("does not leak the prod Run's freeze into another Environment", async () => {
    const jwt = await token(h.signer);
    const res = await h.app.request(
      `/apps/${ids.appId}/envs/${ids.devEnvironmentId}/flags/${ids.flagId}/targeting-rules`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "idempotency-key": "idem_dev_freeze",
        },
        body: JSON.stringify({ idempotency_key: "idem_dev_freeze", targetingRules: [] }),
      },
    );

    expect(res.status).toBe(200);
  });
});

async function readConfig(): Promise<Record<string, unknown>> {
  const jwt = await token(h.signer);
  const res = await h.app.request(
    `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
    { headers: { authorization: `Bearer ${jwt}` } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function countApprovalRequests(): Promise<number> {
  return h.repo.approvals.countRequests(appScope(ids.appId), {});
}

async function endTheRun(): Promise<void> {
  const scope = envScope(ids.appId, ids.environmentId);
  const current = await h.repo.experiments.getExperiment(scope, ids.experimentId);
  if (!current) throw new Error("endTheRun: Experiment not found");
  await h.repo.experiments.updateExperiment(
    scope,
    ids.experimentId,
    { status: "ended", liveRunId: null, updatedAt: NOW },
    current.liveRunId,
  );
}
