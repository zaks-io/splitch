import type { ApprovalRequest } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import { type Harness, ids, setProdPolicy, token, USER_ID } from "../src/config-store-harness-core";
import {
  auditRequest,
  auditRows,
  CANARIES,
  expectPrivateAudit,
} from "./app-audit-mutation-fixture";
import { allowPolicy, confirmPolicy, reviewRequest } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
let jwt: string;
beforeEach(async () => {
  h = await makePoolHarness();
  jwt = await token(h.signer);
  await narrowSeededAvailability(h.d1);
  await setProdPolicy(h, allowPolicy);
  await h.d1
    .prepare("UPDATE targeting_rules SET conditions = ?, percentage_rollout = ? WHERE id = ?")
    .bind(
      JSON.stringify([
        { attribute: "targetingKey", operator: "eq", value: CANARIES.targetingKey },
        { attribute: "privateContext", operator: "eq", value: CANARIES.context },
      ]),
      JSON.stringify({ percentage: 25, salt: CANARIES.secret }),
      ids.devTargetingRuleId,
    )
    .run();
});
afterEach(async () => h.dispose());

function promote(key = "promotion-audit", review = false) {
  return auditRequest({
    app: h.app,
    jwt,
    path: `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/promote`,
    requestId: `request_${key}`,
    idempotencyKey: key,
    body: {
      idempotency_key: key,
      fromEnvironmentId: ids.devEnvironmentId,
      select: { enabled: true, targeting: true },
      ...(review ? { review: { action: "approve_and_apply" } } : {}),
    },
  });
}

it("records each committed Promotion with the actual resulting configuration version", async () => {
  const before = await auditRows(h.repo, ids.appId);
  const response = await promote();
  expect(response.status, await response.clone().text()).toBe(200);
  const config = await h.repo.flags.getFlagConfig(
    envScope(ids.appId, ids.environmentId),
    ids.flagId,
  );
  const rows = (await auditRows(h.repo, ids.appId)).slice(before.length);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    appId: ids.appId,
    organizationId: ids.orgId,
    environmentId: ids.environmentId,
    actorRef: USER_ID,
    actorVia: "anonymous",
    action: "flags_promote",
    resourceType: "flag_configuration",
    resourceId: ids.configId,
    targetVersion: String(config?.version),
    outcome: "committed",
    requestId: "request_promotion-audit",
    approvalRequestId: null,
    runId: null,
  });
  const rules = await h.repo.flags.listTargetingRules(
    envScope(ids.appId, ids.environmentId),
    ids.flagId,
  );
  expect(rules[0]?.conditions).toContain(CANARIES.targetingKey);
  expectPrivateAudit(rows, jwt);

  // An allow-policy Promotion has no recognized replay: another successful write is another fact.
  const repeated = await promote();
  expect(repeated.status).toBe(200);
  const finalConfig = await h.repo.flags.getFlagConfig(
    envScope(ids.appId, ids.environmentId),
    ids.flagId,
  );
  const finalRows = (await auditRows(h.repo, ids.appId)).slice(before.length);
  expect(finalRows).toHaveLength(2);
  expect(finalRows.map((row) => row.targetVersion)).toEqual([
    String(config?.version),
    String(finalConfig?.version),
  ]);
});

it("records indirect Approval creation once, then records its applied Review", async () => {
  await setProdPolicy(h, confirmPolicy);
  const before = await auditRows(h.repo, ids.appId);
  const response = await promote("gated-promotion");
  expect(response.status).toBe(409);
  const body = (await response.json()) as { details: { approvalRequestId: string } };
  const id = body.details.approvalRequestId;
  const request = await h.repo.approvals.getRequest(appScope(ids.appId), id);
  let rows = (await auditRows(h.repo, ids.appId)).slice(before.length);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action: "flags_promote",
    resourceType: "approval_request",
    resourceId: id,
    approvalRequestId: id,
    environmentId: ids.environmentId,
    outcome: "pending",
    targetVersion: request?.targetVersion,
    requestId: "request_gated-promotion",
    actorRef: USER_ID,
  });
  expect(
    (await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId))?.version,
  ).toBe(1);
  expect((await promote("gated-promotion")).status).toBe(409);
  expect((await auditRows(h.repo, ids.appId)).slice(before.length)).toEqual(rows);

  const reviewed = await reviewRequest(h, id, "apply-promotion");
  expect(reviewed.status, await reviewed.clone().text()).toBe(200);
  const applied = (await reviewed.json()) as ApprovalRequest;
  rows = (await auditRows(h.repo, ids.appId)).slice(before.length);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    action: "approval_request_reviews_create",
    outcome: "applied",
    approvalRequestId: id,
    resourceId: id,
    actorRef: USER_ID,
  });
  expect(JSON.parse(rows[1]?.changesJson ?? "null")).toMatchObject({
    reviewId: applied.latestReview?.id,
    resultingTargetVersion: applied.latestReview?.resultingTargetVersion,
    reviewAction: "approve_and_apply",
  });
  expect((await reviewRequest(h, id, "apply-promotion")).status).toBe(200);
  expect((await auditRows(h.repo, ids.appId)).slice(before.length)).toEqual(rows);
  expectPrivateAudit(rows, jwt);
});

it("does not audit a refused Promotion that writes no configuration or Request", async () => {
  const before = await auditRows(h.repo, ids.appId);
  const response = await auditRequest({
    app: h.app,
    jwt,
    path: `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/promote`,
    requestId: "request_refused_promotion",
    idempotencyKey: "refused-promotion",
    body: {
      idempotency_key: "refused-promotion",
      fromEnvironmentId: ids.environmentId,
      select: { enabled: true },
    },
  });
  expect(response.status).toBe(400);
  expect(await auditRows(h.repo, ids.appId)).toEqual(before);
  expect(await h.repo.approvals.countRequests(appScope(ids.appId), {})).toBe(0);
});

it("records both Request and Review for inline Promotion and adds neither on replay", async () => {
  await setProdPolicy(h, confirmPolicy);
  const before = await auditRows(h.repo, ids.appId);
  const response = await promote("inline-promotion", true);
  expect(response.status, await response.clone().text()).toBe(200);
  const rows = (await auditRows(h.repo, ids.appId)).slice(before.length);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => [row.action, row.resourceType, row.outcome])).toEqual([
    ["flags_promote", "approval_request", "pending"],
    ["approval_request_reviews_create", "approval_request", "applied"],
  ]);
  expect(rows[0]?.approvalRequestId).toBe(rows[1]?.approvalRequestId);
  for (const row of rows)
    expect(row).toMatchObject({
      requestId: "request_inline-promotion",
      actorRef: USER_ID,
      environmentId: ids.environmentId,
    });
  expect((await promote("inline-promotion", true)).status).toBe(200);
  expect((await auditRows(h.repo, ids.appId)).slice(before.length)).toEqual(rows);
  expectPrivateAudit(rows, jwt);
});
