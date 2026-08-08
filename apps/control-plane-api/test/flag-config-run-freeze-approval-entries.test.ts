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

  it("does not revert live rollout when applying an enabled-only proposal", async () => {
    await narrowSeededAvailability(h.d1, ["control", "treatment"]);
    expect(
      (await patchConfig(h, "idem_disable_before_rollout_preserve", { enabled: false })).status,
    ).toBe(200);
    const proposed = await patchConfig(h, "idem_propose_enable_preserve_rollout", {
      enabled: true,
    });
    expect(proposed.status).toBe(409);
    const requestId = proposed.approvalRequestId as string;

    // This deliberately skips the production writers' version bump, so it is
    // not a production-reachable state or a reproduction of the TOCTOU window.
    // It directly pins the entries-gated patch against corrupt stored state.
    const liveRollout = JSON.stringify({ percentage: 40, salt: "post-mint" });
    await h.d1
      .prepare("UPDATE flag_configs SET rollout = ? WHERE app_id = ? AND environment_id = ?")
      .bind(liveRollout, ids.appId, ids.environmentId)
      .run();

    await startSeededExperiment(h.d1);
    expect((await reviewRequest(h, requestId, "idem_review_preserve_rollout")).status).toBe(200);

    const after = await readProdConfig();
    expect(after.enabled).toBe(true);
    expect(after.rollout).toEqual({ percentage: 40, salt: "post-mint" });
  });

  it("preserves a versioned PATCH that lands after the staleness read", async () => {
    await setProdPolicy(h, { ...confirmPolicy, targetingRolloutValue: "allow" });
    expect((await patchConfig(h, "idem_disable_before_race", { enabled: false })).status).toBe(200);
    const proposed = await patchConfig(h, "idem_propose_enable_before_race", { enabled: true });
    expect(proposed.status).toBe(409);
    const requestId = proposed.approvalRequestId as string;
    const before = await readProdConfig();

    const entered = deferred<void>();
    const resume = deferred<void>();
    const readConfig = h.repo.flags.getFlagConfig;
    h.repo.flags.getFlagConfig = async (scope, flagId) => {
      h.repo.flags.getFlagConfig = readConfig;
      entered.resolve();
      await resume.promise;
      return readConfig(scope, flagId);
    };

    const review = reviewRequest(h, requestId, "idem_review_after_concurrent_patch");
    await entered.promise;
    const concurrent = await patchConfig(h, "idem_concurrent_rollout", {
      rollout: { percentage: 40 },
    });
    expect(concurrent.status).toBe(200);
    const patched = await readProdConfig();
    expect(patched.version).toBe(before.version + 1);
    resume.resolve();

    expect((await review).status).toBe(200);
    const after = await readProdConfig();
    expect(after.enabled).toBe(true);
    expect(after.rollout).toEqual(patched.rollout);
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

  it("refuses an approved rollout change once a Run owns the field", async () => {
    await narrowSeededAvailability(h.d1, ["control", "treatment"]);
    const proposed = await patchConfig(h, "idem_propose_rollout", { rollout: { percentage: 30 } });
    expect(proposed.status).toBe(409);
    expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");
    const requestId = proposed.approvalRequestId as string;

    const read = await getApprovalRequests(h, requestId);
    const request = (await read.json()) as { diff: { entries: Array<{ path: string }> } };
    expect(request.diff.entries.some((entry) => entry.path.startsWith("/rollout"))).toBe(true);

    await startSeededExperiment(h.d1);
    const res = await reviewRequest(h, requestId, "idem_review_rollout_frozen");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RUN_FROZEN",
      details: {
        frozenFields: ["flagConfig.rollout"],
        currentRunId: ids.liveRunId,
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    });
  });

  it("refuses an approved availability change once a Run owns the field", async () => {
    await narrowSeededAvailability(h.d1, ["control", "treatment"]);
    const proposed = await patchConfig(h, "idem_propose_availability", {
      availableVariantNames: ["control"],
    });
    expect(proposed.status).toBe(409);
    expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");
    const requestId = proposed.approvalRequestId as string;

    const read = await getApprovalRequests(h, requestId);
    const request = (await read.json()) as { diff: { entries: Array<{ path: string }> } };
    expect(
      request.diff.entries.some((entry) => entry.path.startsWith("/availableVariantNames")),
    ).toBe(true);

    await startSeededExperiment(h.d1);
    const res = await reviewRequest(h, requestId, "idem_review_availability_frozen");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RUN_FROZEN",
      details: {
        frozenFields: ["flagConfig.availableVariantNames"],
        currentRunId: ids.liveRunId,
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    });
  });
});

async function readProdConfig(): Promise<{
  version: number;
  enabled: boolean;
  rollout: { percentage: number; salt: string } | null;
}> {
  const row = await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId);
  if (!row) throw new Error("readProdConfig: no Flag Configuration");
  return {
    version: row.version,
    enabled: row.enabled,
    rollout: row.rollout ? (JSON.parse(row.rollout) as { percentage: number; salt: string }) : null,
  };
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

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolved) => {
    resolve = resolved;
  });
  return { promise, resolve };
}
