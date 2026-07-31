import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import type { ApprovalCommit } from "./approval-types";
import { createLocalD1, type LocalD1 } from "./test-d1";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * `startRun` appends the Approval Review and Request resolution to the same D1
 * batch as the Run insert, but used to inspect only the Run statements. A batch
 * where the Run landed and the Review did not therefore returned `ok`, leaving
 * the Run running against a Request still `pending` — the caller then got a
 * misleading 409-stale from reconciliation instead of a signal that the write
 * was inconsistent.
 *
 * Every other Approval write path checks that its own Review row landed; this is
 * that check for this path (ADR-0036, fail loud).
 */

const NOW = "2026-07-03T15:00:00.000Z";
const REVIEWER = "user_start_owner";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
  await local.d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(seed.a.appId, REVIEWER, "owner", NOW)
    .run();
  // The seeded Experiment has no draft; a start needs one to be startable.
  await local.d1
    .prepare(
      `UPDATE experiments
         SET draft_allocation = ?, draft_salt = ?, draft_targeting_rules = ?,
             draft_segment_ids = ?, default_variant_id = ?
       WHERE id = ?`,
    )
    .bind('{"control":100}', "salt_start", "[]", "[]", seed.a.variantId, seed.a.experimentId)
    .run();
  // Only the Experiment's own prior Run may be running when it starts again.
  await local.d1
    .prepare("UPDATE runs SET status = 'ended' WHERE app_id = ?")
    .bind(seed.a.appId)
    .run();
});

afterEach(async () => {
  await local.dispose();
});

async function seedPendingRequest(): Promise<string> {
  const created = await repo.approvals.createRequest(appScope(seed.a.appId), {
    id: "apr_start",
    operation: "experiments_start",
    targetType: "experiment",
    targetId: seed.a.experimentId,
    targetVersion: "1",
    policyContexts: "[]",
    diff: JSON.stringify({ current: {}, proposed: {} }),
    status: "pending",
    proposedBy: "user_start_proposer",
    proposedVia: "api_key",
    proposedAt: NOW,
    idempotencyKey: "idem_start",
    requestHash: "sha256:start",
  });
  if (!created.ok) throw new Error("seed: Approval Request was not created");
  return created.request.id;
}

function commitFor(requestId: string, reviewedAt: string): ApprovalCommit {
  return {
    requestId,
    reviewId: "rev_start_01",
    action: "approve_and_apply",
    reviewedBy: REVIEWER,
    reviewedVia: "api_key",
    reviewedAt,
    reason: null,
    idempotencyKey: "idem_start_review",
    requestHash: "sha256:start",
    resultingTargetVersion: "2",
    resultingResourceType: "experiment_run",
    resultingResourceId: "run_start_new",
    policyContexts: [],
  };
}

function startInput(approval: ApprovalCommit, startedAt: string) {
  return {
    experimentId: seed.a.experimentId,
    flagId: seed.a.flagId,
    expectedDraft: {
      draftAllocation: '{"control":100}',
      draftSalt: "salt_start",
      draftTargetingRules: "[]",
      draftSegmentIds: "[]",
      defaultVariantId: seed.a.variantId,
      liveRunId: null,
    },
    run: {
      id: "run_start_new",
      targetingKeyField: "userId",
      targetingKeyType: "user",
      salt: "salt_start",
      allocation: '{"control":100}',
      variantSet: JSON.stringify([{ id: seed.a.variantId, name: "control", value: "control" }]),
      targetingRules: "[]",
      confidenceLevel: 0.95,
      horizon: "sequential",
      decisionFamily: "[]",
      guardrailDecisions: "[]",
      configHash: "hash_start",
      startedAt,
      createdAt: NOW,
    },
    endedAt: NOW,
    updatedAt: NOW,
    approval,
  };
}

describe("startRun refuses to report success when its Approval Review did not land", () => {
  it("throws instead of returning ok when the Run lands but the Review does not", async () => {
    const requestId = await seedPendingRequest();
    const scope = envScope(seed.a.appId, seed.a.environmentId);
    // The Review insert is bound to the Run it authorized by `started_at =
    // reviewedAt`. A caller that starts the Run at a different instant lands the
    // Run and loses the Review — the exact divergence this check exists for.
    const approval = commitFor(requestId, "2026-07-03T15:00:01.000Z");

    await expect(repo.experiments.startRun(scope, startInput(approval, NOW))).rejects.toThrow(
      "startRun: the Run started but its Approval Review did not land",
    );

    const request = await local.d1
      .prepare("SELECT status FROM approval_requests WHERE id = ?")
      .bind(requestId)
      .first<{ status: string }>();
    expect(request?.status).toBe("pending");
    const reviews = await local.d1.prepare("SELECT id FROM approval_reviews").all();
    expect(reviews.results.length).toBe(0);
  });

  it("positive control: a consistent batch starts the Run and applies the Request", async () => {
    const requestId = await seedPendingRequest();
    const scope = envScope(seed.a.appId, seed.a.environmentId);
    const approval = commitFor(requestId, NOW);

    const started = await repo.experiments.startRun(scope, startInput(approval, NOW));

    expect(started).toMatchObject({ ok: true, run: { id: "run_start_new", status: "running" } });
    const request = await local.d1
      .prepare("SELECT status FROM approval_requests WHERE id = ?")
      .bind(requestId)
      .first<{ status: string }>();
    expect(request?.status).toBe("applied");
    const reviews = await local.d1.prepare("SELECT id, outcome FROM approval_reviews").all();
    expect(reviews.results).toMatchObject([{ id: "rev_start_01", outcome: "applied" }]);
  });

  it("a reviewer without an App role starts nothing at all", async () => {
    const requestId = await seedPendingRequest();
    const scope = envScope(seed.a.appId, seed.a.environmentId);
    const approval = { ...commitFor(requestId, NOW), reviewedBy: "user_start_stranger" };

    expect(await repo.experiments.startRun(scope, startInput(approval, NOW))).toMatchObject({
      ok: false,
      reason: "stale_draft",
    });
    expect(await repo.experiments.getRun(scope, "run_start_new")).toBeNull();
  });
});
