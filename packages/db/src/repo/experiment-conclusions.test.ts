import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

const NOW = "2026-09-08T12:00:00.000Z";
const CONCLUSION_ID = "con_a_01";
const APPROVAL_ID = "apr_a_01";
const CONFIG_ID = "cfg_a";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
  await local.d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(seed.a.appId, "user_a_owner", "owner", NOW)
    .run();
  await repo.flags.flagConfigs.insert(envScope(seed.a.appId, seed.a.environmentId), {
    id: CONFIG_ID,
    appId: seed.a.appId,
    environmentId: seed.a.environmentId,
    flagId: seed.a.flagId,
    enabled: true,
    availableVariantNames: '["control"]',
    defaultVariantId: seed.a.variantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await local.d1
    .prepare(
      "UPDATE experiments SET status = 'running', live_run_id = ? WHERE app_id = ? AND environment_id = ? AND id = ?",
    )
    .bind(seed.a.runId, seed.a.appId, seed.a.environmentId, seed.a.experimentId)
    .run();
});

afterEach(async () => {
  await local.dispose();
});

function commitInput() {
  return {
    expectedLiveRunId: seed.a.runId,
    expectedTargetConfigVersion: 1,
    conclusion: {
      id: CONCLUSION_ID,
      environmentId: seed.a.environmentId,
      experimentId: seed.a.experimentId,
      runId: seed.a.runId,
      selectedVariant: "control",
      configHash: `hash_${seed.a.runId}`,
      resultToken: "sha256:result-a",
      dataWatermark: NOW,
      resultSnapshot: '{"status":"ok"}',
      decisionFailures: "[]",
      decisionChecks: "[]",
      targetEnvironmentId: seed.a.environmentId,
      targetFlagId: seed.a.flagId,
      targetConfigVersion: 1,
      proposedFlagConfiguration: '{"enabled":true}',
      reason: "ship the winner",
      concludedBy: "user_a_owner",
      concludedVia: "api_key",
      concludedAt: NOW,
      idempotencyKey: "conclude-a-01",
      requestHash: "sha256:conclusion-request-a",
    },
    approval: approvalInput(APPROVAL_ID, "conclude-a-01"),
  };
}

function approvalInput(id: string, idempotencyKey: string) {
  return {
    id,
    operation: "experiment_winner_promote",
    targetType: "flag_configuration",
    targetId: CONFIG_ID,
    targetVersion: "1",
    policyContexts: "[]",
    policyGuardContexts:
      '[{"environmentId":"env_a","changeTypes":["enabled_state"],"level":"allow"}]',
    diff: '{"current":{},"proposed":{}}',
    status: "pending",
    proposedBy: "user_a_owner",
    proposedVia: "api_key",
    proposedAt: NOW,
    idempotencyKey,
    requestHash: `sha256:${id}`,
  };
}

async function writeCounts() {
  const [conclusions, approvals, links] = await Promise.all([
    local.d1
      .prepare("SELECT COUNT(*) AS count FROM experiment_conclusions WHERE app_id = ?")
      .bind(seed.a.appId)
      .first<{ count: number }>(),
    local.d1
      .prepare("SELECT COUNT(*) AS count FROM approval_requests WHERE app_id = ?")
      .bind(seed.a.appId)
      .first<{ count: number }>(),
    local.d1
      .prepare("SELECT COUNT(*) AS count FROM conclusion_approval_requests WHERE app_id = ?")
      .bind(seed.a.appId)
      .first<{ count: number }>(),
  ]);
  return {
    conclusions: conclusions?.count ?? -1,
    approvals: approvals?.count ?? -1,
    links: links?.count ?? -1,
  };
}

describe("Experiment conclusion repository transactions", () => {
  it("ends the Run and commits the conclusion, Approval Request, and link atomically", async () => {
    const result = await repo.experimentConclusions.commit(
      envScope(seed.a.appId, seed.a.environmentId),
      commitInput(),
    );

    expect(result.ok).toBe(true);
    expect(await writeCounts()).toEqual({ conclusions: 1, approvals: 1, links: 1 });
    expect(
      await local.d1
        .prepare("SELECT status, ended_at, end_reason FROM runs WHERE id = ?")
        .bind(seed.a.runId)
        .first(),
    ).toMatchObject({ status: "ended", ended_at: NOW, end_reason: "ship the winner" });
    expect(
      await local.d1
        .prepare("SELECT status, live_run_id FROM experiments WHERE id = ?")
        .bind(seed.a.experimentId)
        .first(),
    ).toMatchObject({ status: "draft", live_run_id: null });
    expect(
      await local.d1
        .prepare(
          "SELECT conclusion_id, approval_request_id, ordinal FROM conclusion_approval_requests WHERE app_id = ?",
        )
        .bind(seed.a.appId)
        .first(),
    ).toEqual({
      conclusion_id: CONCLUSION_ID,
      approval_request_id: APPROVAL_ID,
      ordinal: 1,
    });
    expect(
      await local.d1
        .prepare("SELECT policy_guard_contexts FROM approval_requests WHERE id = ?")
        .bind(APPROVAL_ID)
        .first(),
    ).toEqual({
      policy_guard_contexts:
        '[{"environmentId":"env_a","changeTypes":["enabled_state"],"level":"allow"}]',
    });
  });

  it("writes nothing when the Run is already ended and the live Run is already cleared", async () => {
    await local.d1
      .prepare("UPDATE runs SET status = 'ended', ended_at = ? WHERE id = ?")
      .bind(NOW, seed.a.runId)
      .run();
    await local.d1
      .prepare(
        "UPDATE experiments SET status = 'draft', live_run_id = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(NOW, seed.a.experimentId)
      .run();

    await expect(
      repo.experimentConclusions.commit(
        envScope(seed.a.appId, seed.a.environmentId),
        commitInput(),
      ),
    ).rejects.toThrow();
    expect(await writeCounts()).toEqual({ conclusions: 0, approvals: 0, links: 0 });
  });

  it("writes nothing when the target Configuration version has drifted", async () => {
    await local.d1
      .prepare("UPDATE flag_configs SET version = 2 WHERE id = ?")
      .bind(CONFIG_ID)
      .run();

    await expect(
      repo.experimentConclusions.commit(
        envScope(seed.a.appId, seed.a.environmentId),
        commitInput(),
      ),
    ).rejects.toThrow();
    expect(await writeCounts()).toEqual({ conclusions: 0, approvals: 0, links: 0 });
    expect(
      await local.d1.prepare("SELECT status FROM runs WHERE id = ?").bind(seed.a.runId).first(),
    ).toMatchObject({ status: "running" });
  });

  it("writes nothing when the concluding actor loses App admin membership", async () => {
    await local.d1
      .prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(seed.a.appId, "user_a_owner")
      .run();

    await expect(
      repo.experimentConclusions.commit(
        envScope(seed.a.appId, seed.a.environmentId),
        commitInput(),
      ),
    ).rejects.toThrow();
    expect(await writeCounts()).toEqual({ conclusions: 0, approvals: 0, links: 0 });
    expect(
      await local.d1.prepare("SELECT status FROM runs WHERE id = ?").bind(seed.a.runId).first(),
    ).toMatchObject({ status: "running" });
  });
});

describe("Experiment conclusion replacement transactions", () => {
  it("creates a replacement only from a stale Approval Request and preserves the ordinal link", async () => {
    await repo.experimentConclusions.commit(
      envScope(seed.a.appId, seed.a.environmentId),
      commitInput(),
    );
    await local.d1
      .prepare("UPDATE approval_requests SET status = 'stale', resolved_at = ? WHERE id = ?")
      .bind(NOW, APPROVAL_ID)
      .run();

    expect(
      await repo.experimentConclusions.createReplacement(
        appScope(seed.a.appId),
        replacementInput(),
      ),
    ).toBe(true);
    expect(
      (
        await local.d1
          .prepare(
            "SELECT approval_request_id, ordinal FROM conclusion_approval_requests WHERE conclusion_id = ? ORDER BY ordinal",
          )
          .bind(CONCLUSION_ID)
          .all()
      ).results,
    ).toEqual([
      { approval_request_id: APPROVAL_ID, ordinal: 1 },
      { approval_request_id: "apr_a_02", ordinal: 2 },
    ]);
  });

  it("atomically materializes effective staleness before replacing a stored pending Request", async () => {
    await repo.experimentConclusions.commit(
      envScope(seed.a.appId, seed.a.environmentId),
      commitInput(),
    );

    expect(
      await repo.experimentConclusions.createReplacement(
        appScope(seed.a.appId),
        replacementInput(),
      ),
    ).toBe(true);
    expect(
      await local.d1
        .prepare("SELECT status, resolved_at FROM approval_requests WHERE id = ?")
        .bind(APPROVAL_ID)
        .first(),
    ).toEqual({ status: "stale", resolved_at: NOW });
    expect(await writeCounts()).toEqual({ conclusions: 1, approvals: 2, links: 2 });
  });

  it("refuses to replace a pending Approval Request", async () => {
    await repo.experimentConclusions.commit(
      envScope(seed.a.appId, seed.a.environmentId),
      commitInput(),
    );

    await expect(
      repo.experimentConclusions.createReplacement(
        appScope(seed.a.appId),
        replacementInput({ currentTargetVersion: "1" }),
      ),
    ).rejects.toThrow();
    expect(await writeCounts()).toEqual({ conclusions: 1, approvals: 1, links: 1 });
  });

  it("refuses a replacement after the proposing actor loses App admin membership", async () => {
    await repo.experimentConclusions.commit(
      envScope(seed.a.appId, seed.a.environmentId),
      commitInput(),
    );
    await local.d1
      .prepare("UPDATE approval_requests SET status = 'stale', resolved_at = ? WHERE id = ?")
      .bind(NOW, APPROVAL_ID)
      .run();
    await local.d1
      .prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(seed.a.appId, "user_a_owner")
      .run();

    await expect(
      repo.experimentConclusions.createReplacement(appScope(seed.a.appId), replacementInput()),
    ).rejects.toThrow();
    expect(await writeCounts()).toEqual({ conclusions: 1, approvals: 1, links: 1 });
  });
});

function replacementInput(overrides: { currentTargetVersion?: string } = {}) {
  return {
    conclusionId: CONCLUSION_ID,
    previousApprovalRequestId: APPROVAL_ID,
    ordinal: 2,
    approval: approvalInput("apr_a_02", "replace-a-02"),
    targetEnvironmentId: seed.a.environmentId,
    targetFlagId: seed.a.flagId,
    expectedTargetConfigVersion: 1,
    previousTargetVersion: "1",
    currentTargetVersion: overrides.currentTargetVersion ?? "sha256:target-v2",
    createdAt: NOW,
  };
}
