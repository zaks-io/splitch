import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
} from "../src/experiment-run-test-fixture";
import { NOW_ISO, OWNER } from "../src/flag-definition-test-harness";
import {
  auditRequest,
  auditRows,
  CANARIES,
  expectPrivateAudit,
} from "./app-audit-mutation-fixture";
import { confirmPolicy } from "./approval-harness";
import { makePoolBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;
beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makePoolBindings);
});
afterEach(async () => ctx.h.bindings.dispose());

async function fixture() {
  const fx = await experimentFixture(ctx);
  const draft = await createExperimentDraft(ctx, fx, {
    key: "audit-run",
    allocation: { control: 50, treatment: 50 },
    salt: CANARIES.secret,
    targetingKey: CANARIES.targetingKey,
    targetingRules: [
      {
        id: "rule_audit",
        flagId: fx.flag.id,
        priority: 0,
        variantId: fx.flag.defaultVariantId,
        conditions: [{ attribute: "privateContext", operator: "eq", value: CANARIES.context }],
      },
    ],
  });
  const start = (key = "start-audit") =>
    auditRequest({
      app: ctx.h.app,
      jwt: fx.jwt,
      path: `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${draft.id}/start`,
      requestId: `request_${key}`,
      idempotencyKey: key,
      body: { idempotency_key: key, reason: CANARIES.reason },
    });
  return { fx, draft, start };
}

it("records Start and End once each, with frozen config and actor correlation", async () => {
  const { fx, draft, start } = await fixture();
  const before = await auditRows(ctx.repo, fx.appId);
  const response = await start();
  expect(response.status, await response.clone().text()).toBe(200);
  const started = (await response.json()) as { run: { id: string } };
  const scope = envScope(fx.appId, fx.environmentId);
  const run = await ctx.repo.experiments.getRun(scope, started.run.id);
  expect(run).toMatchObject({
    status: "running",
    salt: CANARIES.secret,
    targetingKeyField: CANARIES.targetingKey,
  });
  expect(run?.targetingRules).toContain(CANARIES.context);
  let rows = (await auditRows(ctx.repo, fx.appId)).slice(before.length);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action: "experiments_start",
    resourceType: "run",
    resourceId: started.run.id,
    runId: started.run.id,
    targetVersion: run?.configHash,
    actorRef: OWNER,
    actorVia: "anonymous",
    environmentId: fx.environmentId,
    requestId: "request_start-audit",
    changedAt: NOW_ISO,
    outcome: "committed",
    approvalRequestId: null,
  });
  expect((await start()).status).toBe(409);
  expect((await auditRows(ctx.repo, fx.appId)).slice(before.length)).toEqual(rows);
  const end = () =>
    auditRequest({
      app: ctx.h.app,
      jwt: fx.jwt,
      path: `/apps/${fx.appId}/envs/${fx.environmentId}/runs/${started.run.id}/end`,
      requestId: "request_end-audit",
      body: { reason: CANARIES.reason },
    });
  expect((await end()).status).toBe(200);
  rows = (await auditRows(ctx.repo, fx.appId)).slice(before.length);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    action: "runs_end",
    resourceType: "run",
    resourceId: started.run.id,
    runId: started.run.id,
    targetVersion: run?.configHash,
    requestId: "request_end-audit",
    actorRef: OWNER,
    actorVia: "anonymous",
    environmentId: fx.environmentId,
    outcome: "committed",
  });
  expect(await ctx.repo.experiments.getRun(scope, started.run.id)).toMatchObject({
    status: "ended",
    endReason: CANARIES.reason,
  });
  expect(await ctx.repo.experiments.getExperiment(scope, draft.id)).toMatchObject({
    liveRunId: null,
  });
  expect((await end()).status).toBe(409);
  expect((await auditRows(ctx.repo, fx.appId)).slice(before.length)).toEqual(rows);
  expectPrivateAudit(rows, fx.jwt);
});

it("records gated Start Request, then the committed Review and Run, with no replay duplicates", async () => {
  const { fx, draft, start } = await fixture();
  await ctx.repo.identity.updateEnvironment(appScope(fx.appId), fx.environmentId, {
    policy: JSON.stringify(confirmPolicy),
    updatedAt: NOW_ISO,
  });
  const before = await auditRows(ctx.repo, fx.appId);
  const pending = await start();
  expect(pending.status, await pending.clone().text()).toBe(409);
  const body = (await pending.json()) as { details: { approvalRequestId: string } };
  const id = body.details.approvalRequestId;
  const request = await ctx.repo.approvals.getRequest(appScope(fx.appId), id);
  let rows = (await auditRows(ctx.repo, fx.appId)).slice(before.length);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action: "experiments_start",
    resourceType: "approval_request",
    resourceId: id,
    approvalRequestId: id,
    outcome: "pending",
    targetVersion: request?.targetVersion,
    requestId: "request_start-audit",
  });
  expect(
    await ctx.repo.experiments.listRunsForExperiment(
      envScope(fx.appId, fx.environmentId),
      draft.id,
    ),
  ).toEqual([]);
  expect((await start()).status).toBe(409);
  expect((await auditRows(ctx.repo, fx.appId)).slice(before.length)).toEqual(rows);
  const review = () =>
    auditRequest({
      app: ctx.h.app,
      jwt: fx.jwt,
      path: `/apps/${fx.appId}/approval-requests/${id}/reviews`,
      requestId: "request_review-start",
      idempotencyKey: "review-start",
      body: {
        action: "approve_and_apply",
        idempotency_key: "review-start",
        reason: CANARIES.reason,
      },
    });
  const applied = await review();
  expect(applied.status, await applied.clone().text()).toBe(200);
  const stored = await ctx.repo.approvals.getRequest(appScope(fx.appId), id);
  const latestReview = await ctx.repo.approvals.latestReview(appScope(fx.appId), id);
  const runId = stored?.resultingResourceId;
  expect(runId).toEqual(expect.any(String));
  rows = (await auditRows(ctx.repo, fx.appId)).slice(before.length);
  expect(rows).toHaveLength(3);
  expect(
    rows
      .slice(1)
      .map((row) => row.action)
      .sort(),
  ).toEqual(["approval_request_reviews_create", "experiments_start"]);
  for (const row of rows.slice(1))
    expect(row).toMatchObject({
      runId,
      approvalRequestId: id,
      requestId: "request_review-start",
      actorRef: OWNER,
      actorVia: "anonymous",
      environmentId: fx.environmentId,
    });
  const reviewed = rows.find((row) => row.action === "approval_request_reviews_create");
  expect(JSON.parse(reviewed?.changesJson ?? "null")).toMatchObject({
    reviewId: latestReview?.id,
    resultingTargetVersion: stored?.resultingTargetVersion,
  });
  expect((await review()).status).toBe(200);
  expect((await start()).status).toBe(200);
  expect((await auditRows(ctx.repo, fx.appId)).slice(before.length)).toEqual(rows);
  expectPrivateAudit(rows, fx.jwt);
});

it("does not audit a Start rejected before any Run or Request write", async () => {
  const { fx, draft, start } = await fixture();
  await ctx.repo.experiments.updateExperiment(
    envScope(fx.appId, fx.environmentId),
    draft.id,
    { defaultVariantId: "missing_variant", updatedAt: NOW_ISO },
    null,
  );
  const before = await auditRows(ctx.repo, fx.appId);
  expect((await start()).status).toBe(409);
  expect(await auditRows(ctx.repo, fx.appId)).toEqual(before);
  expect(await ctx.repo.approvals.countRequests(appScope(fx.appId), {})).toBe(0);
  expect(
    await ctx.repo.experiments.listRunsForExperiment(
      envScope(fx.appId, fx.environmentId),
      draft.id,
    ),
  ).toEqual([]);
});
