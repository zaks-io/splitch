import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

const PROPOSED_AT = "2026-09-08T10:00:00.000Z";
const RESOLVED_AT = "2026-09-08T11:00:00.000Z";
const ARCHIVE_AFTER = "2026-09-08T12:00:00.000Z";
const LINKED_REQUEST_ID = "apr_conclusion_linked";
const ORDINARY_REQUEST_ID = "apr_ordinary_terminal";
const CONCLUSION_ID = "con_archive_retention";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
  await seedTerminalRequest(LINKED_REQUEST_ID);
  await seedTerminalRequest(ORDINARY_REQUEST_ID);
  await seedConclusionLink();
});

afterEach(async () => {
  await local.dispose();
});

describe("conclusion Approval Request archive retention", () => {
  it("retains linked evidence while ordinary terminal Requests still archive", async () => {
    const candidates = await repo.approvals.listArchiveCandidates(ARCHIVE_AFTER, 10);
    expect(candidates.map((candidate) => candidate.id)).toEqual([ORDINARY_REQUEST_ID]);

    await expect(
      repo.approvals.finalizeArchive(
        appScope(seed.a.appId),
        { requestId: LINKED_REQUEST_ID, resolvedAt: RESOLVED_AT, reviewCount: 1 },
        "applied",
      ),
    ).rejects.toThrow(`Approval Request ${LINKED_REQUEST_ID} archive finalization failed`);
    expect(await rowCounts(LINKED_REQUEST_ID)).toEqual({ requests: 1, reviews: 1 });

    await repo.approvals.finalizeArchive(
      appScope(seed.a.appId),
      { requestId: ORDINARY_REQUEST_ID, resolvedAt: RESOLVED_AT, reviewCount: 1 },
      "applied",
    );
    expect(await rowCounts(ORDINARY_REQUEST_ID)).toEqual({ requests: 0, reviews: 0 });
  });
});

async function seedTerminalRequest(requestId: string): Promise<void> {
  const created = await repo.approvals.createRequest(appScope(seed.a.appId), {
    id: requestId,
    operation: "flag_config_update",
    targetType: "flag_configuration",
    targetId: seed.a.flagId,
    targetVersion: "sha256:target",
    policyContexts: "[]",
    diff: '{"current":{},"proposed":{}}',
    status: "applied",
    proposedBy: `user_${requestId}`,
    proposedVia: "api_key",
    proposedAt: PROPOSED_AT,
    resolvedAt: RESOLVED_AT,
    resultingTargetVersion: "sha256:result",
    resultingResourceType: "flag_configuration",
    resultingResourceId: seed.a.flagId,
    idempotencyKey: `idem_${requestId}`,
    requestHash: `sha256:${requestId}`,
  });
  if (!created.ok) throw new Error(`failed to seed ${requestId}`);
  await local.d1
    .prepare(
      `INSERT INTO approval_reviews
       (id, app_id, approval_request_id, action, outcome, reviewed_by, reviewed_via, reviewed_at,
        idempotency_key, request_hash)
       VALUES (?, ?, ?, 'approve_and_apply', 'applied', ?, 'api_key', ?, ?, ?)`,
    )
    .bind(
      `rev_${requestId}`,
      seed.a.appId,
      requestId,
      `reviewer_${requestId}`,
      RESOLVED_AT,
      `review_${requestId}`,
      `sha256:review_${requestId}`,
    )
    .run();
}

async function seedConclusionLink(): Promise<void> {
  await local.d1
    .prepare(
      `INSERT INTO experiment_conclusions
       (id, app_id, environment_id, experiment_id, run_id, selected_variant, config_hash,
        result_token, data_watermark, result_snapshot, decision_failures, decision_checks,
        target_environment_id, target_flag_id, target_config_version, proposed_flag_configuration,
        reason, concluded_by, concluded_via, concluded_at, idempotency_key, request_hash)
       VALUES (?, ?, ?, ?, ?, 'control', 'sha256:config', 'sha256:result', ?, '{}', '[]', '[]',
        ?, ?, 1, '{}', NULL, 'user_owner', 'api_key', ?, 'conclude_archive', 'sha256:conclude')`,
    )
    .bind(
      CONCLUSION_ID,
      seed.a.appId,
      seed.a.environmentId,
      seed.a.experimentId,
      seed.a.runId,
      RESOLVED_AT,
      seed.a.environmentId,
      seed.a.flagId,
      RESOLVED_AT,
    )
    .run();
  await local.d1
    .prepare(
      `INSERT INTO conclusion_approval_requests
       (app_id, conclusion_id, approval_request_id, ordinal, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .bind(seed.a.appId, CONCLUSION_ID, LINKED_REQUEST_ID, RESOLVED_AT)
    .run();
}

async function rowCounts(requestId: string): Promise<{ requests: number; reviews: number }> {
  const [requests, reviews] = await Promise.all([
    local.d1
      .prepare("SELECT COUNT(*) AS count FROM approval_requests WHERE id = ?")
      .bind(requestId)
      .first<{ count: number }>(),
    local.d1
      .prepare("SELECT COUNT(*) AS count FROM approval_reviews WHERE approval_request_id = ?")
      .bind(requestId)
      .first<{ count: number }>(),
  ]);
  return { requests: requests?.count ?? -1, reviews: reviews?.count ?? -1 };
}
