import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import {
  type Harness,
  ids,
  setProdPolicy,
  startSeededExperiment,
  token,
} from "../src/config-store-harness-core";
import { confirmPolicy, getApprovalRequests, patchConfig, reviewRequest } from "./approval-harness";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

/**
 * SPL-304. The approve_and_apply Run-freeze check must key off the Approval
 * Request's own `diff.entries`, not a re-diff of the complete proposed
 * snapshot against live state. These cases pin both directions of that
 * changed-field computation against a live Run.
 */

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
  await setProdPolicy(h, confirmPolicy);
});

afterEach(async () => {
  await h.dispose();
});

describe("approve_and_apply freeze uses the request's changed-field set", () => {
  it("applies an enabled-only proposal while a Run is live", async () => {
    await narrowSeededAvailability(h.d1, ["control", "treatment"]);
    await insertProdTargetingRule();
    // Fixture ships enabled=true; disable ungated, then propose enable under confirm.
    // Distinct idempotency keys: a shared key would 409 as IDEMPOTENCY_KEY_CONFLICT.
    expect((await patchConfig(h, "idem_disable_for_enable_gate", { enabled: false })).status).toBe(
      200,
    );
    const proposed = await patchConfig(h, "idem_propose_enable_under_run", { enabled: true });
    expect(proposed.status).toBe(409);
    expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");
    const requestId = proposed.approvalRequestId as string;

    const read = await getApprovalRequests(h, requestId);
    const request = (await read.json()) as {
      diff: { entries: Array<{ path: string }> };
    };
    expect(request.diff.entries.map((entry) => entry.path).sort()).toEqual([
      "/enabled",
      "/version",
    ]);

    await startSeededExperiment(h.d1);
    const res = await reviewRequest(h, requestId, "idem_review_enabled_under_run");

    expect(res.status).toBe(200);
    expect((await readProdConfig()).enabled).toBe(true);
  });

  it("refuses a genuine frozen-field proposal naming only that field", async () => {
    await narrowSeededAvailability(h.d1, ["control", "treatment"]);
    await insertProdTargetingRule();
    const jwt = await token(h.signer);
    const propose = await h.app.request(
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/targeting-rules`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "idempotency-key": "idem_propose_targeting",
        },
        body: JSON.stringify({
          idempotency_key: "idem_propose_targeting",
          targetingRules: [
            {
              id: "rule_prod_replacement",
              flagId: ids.flagId,
              priority: 0,
              conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
              variantId: ids.treatmentVariantId,
            },
          ],
        }),
      },
    );
    expect(propose.status).toBe(409);
    const proposed = (await propose.json()) as {
      code: string;
      details: { approvalRequestId: string };
    };
    expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");
    const requestId = proposed.details.approvalRequestId;
    expect(requestId).toMatch(/^apr_/);

    await startSeededExperiment(h.d1);
    const res = await reviewRequest(h, requestId, "idem_review_targeting_frozen");

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
});

async function readProdConfig(): Promise<{ enabled: boolean }> {
  const row = await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId);
  if (!row) throw new Error("readProdConfig: no Flag Configuration");
  return { enabled: row.enabled };
}

/**
 * Prod ships with no Targeting Rules in the fixture. The cold-run false
 * `RUN_FROZEN` named `flagConfig.targetingRules` for an enabled-only request;
 * seeding a rule here makes that field present in the complete proposed
 * snapshot the way production had it, so the entries-based check is what
 * keeps the freeze from blaming an untouched neighbour.
 */
async function insertProdTargetingRule(): Promise<void> {
  await h.repo.flags.targetingRules.insert(envScope(ids.appId, ids.environmentId), {
    id: "rule_prod_untouched",
    appId: ids.appId,
    environmentId: ids.environmentId,
    flagId: ids.flagId,
    priority: 0,
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "pro" }]),
    variantId: ids.treatmentVariantId,
    percentageRollout: null,
    createdAt: "2026-07-01T18:00:00.000Z",
    updatedAt: "2026-07-01T18:00:00.000Z",
  });
}
