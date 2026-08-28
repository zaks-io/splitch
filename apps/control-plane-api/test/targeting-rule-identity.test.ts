import { TARGETING_RULE_ID_DUPLICATE_MESSAGE } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConfigStore } from "../src/config-store";
import {
  makeSnapshotRevisionCounter,
  narrowSeededAvailability,
} from "../src/config-store-fixture-data";
import {
  type Harness,
  ids,
  promoteFlagConfig,
  replaceTargetingRules,
  setProdPolicy,
  token,
} from "../src/config-store-harness-core";
import { renderFlagConfigWriteResult } from "../src/flag-config-handler-render";
import { reviewRequest } from "./approval-harness";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

const SECOND_FLAG_ID = "flag_search";
const SECOND_TREATMENT_ID = "var_search_treatment";
const confirmPolicy = {
  variantAvailability: "confirm",
  targetingRolloutValue: "confirm",
  enabledState: "confirm",
  startExperimentRun: "confirm",
} as const;

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
  await narrowSeededAvailability(h.d1);
});

afterEach(async () => {
  await h.dispose();
});

describe("Targeting Rule identity", () => {
  it("lets two Flags in the same Environment persist rule-admin", async () => {
    await seedSecondFlag();

    const first = await replaceTargetingRules(h, { targetingRules: [adminRule(ids.flagId)] });
    const second = await putRules(SECOND_FLAG_ID, ids.environmentId, [adminRule(SECOND_FLAG_ID)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await persistedRuleFlags("rule-admin")).toEqual([ids.flagId, SECOND_FLAG_ID]);
  });

  it("lets the same Flag keep rule-admin in two Environments", async () => {
    const prod = await replaceTargetingRules(h, { targetingRules: [adminRule(ids.flagId)] });
    const dev = await putRules(ids.flagId, ids.devEnvironmentId, [adminRule(ids.flagId)]);

    expect(prod.status).toBe(200);
    expect(dev.status).toBe(200);
    expect(await persistedRuleEnvs("rule-admin")).toEqual([
      ids.devEnvironmentId,
      ids.environmentId,
    ]);
  });

  it("rejects repeated ids in one list as VALIDATION_ERROR before an Approval Request exists", async () => {
    await setProdPolicy(h, confirmPolicy);
    const before = await h.repo.approvals.countRequests(appScope(ids.appId), {});

    const res = await replaceTargetingRules(h, {
      targetingRules: [adminRule(ids.flagId), { ...adminRule(ids.flagId), priority: 1 }],
      review: { action: "approve_and_apply" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [
          {
            path: ["body", "targetingRules", "1", "id"],
            message: TARGETING_RULE_ID_DUPLICATE_MESSAGE,
          },
        ],
      },
    });
    expect(await h.repo.approvals.countRequests(appScope(ids.appId), {})).toBe(before);
  });

  it("maps a persist uniqueness race to VALIDATION_ERROR instead of 500", async () => {
    const persist = await h.repo.flags.replaceTargetingRules(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
      [persistRow("rule-admin"), persistRow("rule-admin")],
      { updatedAt: "2026-07-01T20:00:00.000Z" },
    );
    expect(persist).toEqual({ ok: false, reason: "id_conflict" });

    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast() {} },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
      now: () => new Date("2026-07-01T20:00:00.000Z"),
    });
    const conflict = await store.replaceTargetingRules({
      actor: { ref: "user_config_admin", via: "session" },
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      targetingRules: [adminRule(ids.flagId), { ...adminRule(ids.flagId), priority: 1 }],
    });
    expect(conflict).toMatchObject({ ok: false, reason: "TARGETING_RULE_ID_CONFLICT" });
    const response = renderFlagConfigWriteResult(
      conflict,
      ids.flagId,
      ids.environmentId,
      "req_1",
      null,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [{ path: ["body", "targetingRules", "1", "id"] }],
      },
    });
  });

  it("keeps the source Targeting Rule id when selected Promotion lands through Approval Review", async () => {
    await setProdPolicy(h, confirmPolicy);
    const proposed = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { targeting: true },
    });
    expect(proposed.status).toBe(409);
    const proposal = (await proposed.json()) as { details: { approvalRequestId: string } };
    const requestId = proposal.details.approvalRequestId;
    const stored = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    expect(JSON.parse(stored?.diff ?? "{}")).toMatchObject({
      proposed: {
        targetingRules: [expect.objectContaining({ id: ids.devTargetingRuleId })],
      },
    });
    expect(await persistedRuleEnvs(ids.devTargetingRuleId)).toEqual([ids.devEnvironmentId]);

    const reviewed = await reviewRequest(h, requestId, "idem_promote_targeting_review");
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({
      id: requestId,
      status: "applied",
    });
    expect(await persistedRuleEnvs(ids.devTargetingRuleId)).toEqual([
      ids.devEnvironmentId,
      ids.environmentId,
    ]);
  });
});

function adminRule(flagId: string) {
  return {
    id: "rule-admin",
    flagId,
    priority: 0,
    conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
    variantId: flagId === SECOND_FLAG_ID ? SECOND_TREATMENT_ID : ids.treatmentVariantId,
  };
}

function persistRow(id: string) {
  return {
    id,
    priority: 0,
    conditions: "[]",
    segmentId: null,
    variantId: ids.treatmentVariantId,
    percentageRollout: null,
    createdAt: "2026-07-01T20:00:00.000Z",
    updatedAt: "2026-07-01T20:00:00.000Z",
  };
}

async function seedSecondFlag(): Promise<void> {
  const scope = appScope(ids.appId);
  await h.repo.flags.flags.insert(scope, {
    id: SECOND_FLAG_ID,
    appId: ids.appId,
    key: "search",
    name: "Search",
    defaultVariantId: "var_search_control",
    createdAt: "2026-07-01T20:00:00.000Z",
    updatedAt: "2026-07-01T20:00:00.000Z",
  });
  await h.repo.flags.addVariant(scope, SECOND_FLAG_ID, {
    id: "var_search_control",
    name: "control",
    value: JSON.stringify("off"),
    createdAt: "2026-07-01T20:00:00.000Z",
  });
  await h.repo.flags.addVariant(scope, SECOND_FLAG_ID, {
    id: SECOND_TREATMENT_ID,
    name: "treatment",
    value: JSON.stringify("on"),
    createdAt: "2026-07-01T20:00:00.000Z",
  });
  await h.repo.flags.flagConfigs.insert(envScope(ids.appId, ids.environmentId), {
    id: "flag_config_search_prod",
    appId: ids.appId,
    environmentId: ids.environmentId,
    flagId: SECOND_FLAG_ID,
    enabled: false,
    availableVariantNames: JSON.stringify(["control", "treatment"]),
    defaultVariantId: "var_search_control",
    createdAt: "2026-07-01T20:00:00.000Z",
    updatedAt: "2026-07-01T20:00:00.000Z",
  });
}

async function putRules(
  flagId: string,
  environmentId: string,
  targetingRules: Array<Record<string, unknown>>,
): Promise<Response> {
  const jwt = await token(h.signer);
  return h.app.request(`/apps/${ids.appId}/envs/${environmentId}/flags/${flagId}/targeting-rules`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": `idem_${flagId}_${environmentId}`,
    },
    body: JSON.stringify({
      idempotency_key: `idem_${flagId}_${environmentId}`,
      targetingRules,
    }),
  });
}

async function persistedRuleFlags(id: string): Promise<string[]> {
  const rows = await h.d1
    .prepare(
      "SELECT flag_id FROM targeting_rules WHERE app_id = ? AND environment_id = ? AND id = ? ORDER BY flag_id",
    )
    .bind(ids.appId, ids.environmentId, id)
    .all<{ flag_id: string }>();
  return rows.results.map((row) => row.flag_id);
}

async function persistedRuleEnvs(id: string): Promise<string[]> {
  const rows = await h.d1
    .prepare(
      "SELECT environment_id FROM targeting_rules WHERE app_id = ? AND flag_id = ? AND id = ? ORDER BY environment_id",
    )
    .bind(ids.appId, ids.flagId, id)
    .all<{ environment_id: string }>();
  return rows.results.map((row) => row.environment_id);
}
