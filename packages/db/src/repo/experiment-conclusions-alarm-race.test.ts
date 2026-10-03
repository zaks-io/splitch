import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

const NOW = "2026-09-08T12:00:00.000Z";
const CONCLUSION_ID = "con_a_01";
const APPROVAL_ID = "apr_a_01";
const CONFIG_ID = "cfg_a";

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  const repo = createRepository(local.d1);
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

describe("Experiment conclusion SRM alarm race", () => {
  it("writes nothing when an SRM alarm lands between the pre-read and the commit batch", async () => {
    let fired = false;
    const racyD1 = new Proxy(local.d1, {
      get(target, property, receiver) {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (statements: unknown[]) => {
          if (!fired) {
            fired = true;
            await target
              .prepare(
                `INSERT INTO run_srm_alarms (
                   run_id, srm_kind, first_crossed_at, watermark, p_value,
                   analysis_version, app_id, environment_id
                 ) VALUES (?, 'exposure', ?, ?, 0.0001, 'analysis-v2', ?, ?)`,
              )
              .bind(seed.a.runId, NOW, NOW, seed.a.appId, seed.a.environmentId)
              .run();
          }
          return target.batch(statements as never);
        };
      },
    }) as D1Database;
    const racyRepo = createRepository(racyD1);

    await expect(
      racyRepo.experimentConclusions.commit(envScope(seed.a.appId, seed.a.environmentId), {
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
        approval: {
          id: APPROVAL_ID,
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
          idempotencyKey: "conclude-a-01",
          requestHash: `sha256:${APPROVAL_ID}`,
        },
      }),
    ).rejects.toThrow();

    const [conclusions, approvals, links, run, experiment] = await Promise.all([
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
      local.d1.prepare("SELECT status FROM runs WHERE id = ?").bind(seed.a.runId).first(),
      local.d1
        .prepare("SELECT status, live_run_id FROM experiments WHERE id = ?")
        .bind(seed.a.experimentId)
        .first(),
    ]);
    expect({
      conclusions: conclusions?.count ?? -1,
      approvals: approvals?.count ?? -1,
      links: links?.count ?? -1,
    }).toEqual({ conclusions: 0, approvals: 0, links: 0 });
    expect(run).toMatchObject({ status: "running" });
    expect(experiment).toMatchObject({ status: "running", live_run_id: seed.a.runId });
  });
});
