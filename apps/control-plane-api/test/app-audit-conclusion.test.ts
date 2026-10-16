import type { ConcludeRunResponse, CreateConclusionPromotionResponse } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  type ExperimentRunHarness,
  makeExperimentRunHarness,
} from "../src/experiment-run-test-fixture";
import { OWNER } from "../src/flag-definition-test-harness";
import { auditConclusionFixture } from "./app-audit-conclusion-fixture";
import {
  auditRequest,
  auditRows,
  CANARIES,
  expectPrivateAudit,
} from "./app-audit-mutation-fixture";
import { makePoolBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;
beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makePoolBindings);
});
afterEach(async () => {
  // The shared graph reset predates Conclusions. Clear only this suite's child rows first.
  await ctx.h.bindings.d1.batch([
    ctx.h.bindings.d1.prepare("DELETE FROM conclusion_approval_requests"),
    ctx.h.bindings.d1.prepare("DELETE FROM experiment_conclusions"),
  ]);
  await ctx.h.bindings.dispose();
});

it("commits two distinct facts for Conclusion plus initial Request, then no facts on exact replay", async () => {
  const f = await auditConclusionFixture(ctx);
  const before = await auditRows(ctx.repo, f.fx.appId);
  const response = await f.conclude();
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as ConcludeRunResponse;
  expect(body).toMatchObject({
    run: { id: f.run.id, status: "ended" },
    approvalRequest: { status: "pending" },
    conclusion: { runId: f.run.id },
  });
  const rows = (await auditRows(ctx.repo, f.fx.appId)).slice(before.length);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    action: "runs_conclude",
    resourceType: "run",
    resourceId: f.run.id,
    runId: f.run.id,
    targetVersion: f.run.configHash,
    outcome: "committed",
    approvalRequestId: body.approvalRequest.id,
  });
  expect(rows[1]).toMatchObject({
    action: "runs_conclude",
    resourceType: "approval_request",
    resourceId: body.approvalRequest.id,
    approvalRequestId: body.approvalRequest.id,
    runId: f.run.id,
    targetVersion: body.approvalRequest.target.version,
    outcome: "pending",
  });
  for (const row of rows)
    expect(row).toMatchObject({
      requestId: "request_conclude-audit",
      actorRef: OWNER,
      actorVia: "anonymous",
      environmentId: f.fx.environmentId,
    });
  expect(
    await ctx.repo.experimentConclusions.get(f.scope, f.draft.id, f.run.id, body.conclusion.id),
  ).toMatchObject({ runId: f.run.id, reason: CANARIES.reason });
  expect(await ctx.repo.experiments.getRun(f.scope, f.run.id)).toMatchObject({ status: "ended" });
  const replay = await f.conclude();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(body);
  expect((await auditRows(ctx.repo, f.fx.appId)).slice(before.length)).toEqual(rows);
  const conflict = await f.conclude({ reason: "changed reason" });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  expect((await auditRows(ctx.repo, f.fx.appId)).slice(before.length)).toEqual(rows);
  expectPrivateAudit(rows, f.fx.jwt);
});

it("audits replacement Request and resulting Review/configuration with the same Run correlation", async () => {
  const f = await auditConclusionFixture(ctx);
  const initial = await f.conclude();
  expect(initial.status, await initial.clone().text()).toBe(200);
  const concluded = (await initial.json()) as ConcludeRunResponse;
  await ctx.repo.flags.updateFlagConfig(f.scope, f.fx.flag.id, {
    rollout: JSON.stringify({ percentage: 50, salt: CANARIES.secret }),
    updatedAt: "2026-07-19T00:00:00.000Z",
  });
  const config = await ctx.repo.flags.getFlagConfig(f.scope, f.fx.flag.id);
  if (!config) throw new Error("missing replacement target Configuration");
  const before = await auditRows(ctx.repo, f.fx.appId);
  const path = `${f.path}/${concluded.conclusion.id}/promotion-requests`;
  const replace = () =>
    auditRequest({
      app: f.app,
      jwt: f.fx.jwt,
      path,
      requestId: "request_replacement",
      idempotencyKey: "replacement-audit",
      body: { expectedConfigVersion: config.version, idempotencyKey: "replacement-audit" },
    });
  const response = await replace();
  expect(response.status, await response.clone().text()).toBe(200);
  const replacement = (await response.json()) as CreateConclusionPromotionResponse;
  let rows = (await auditRows(ctx.repo, f.fx.appId)).slice(before.length);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action: "conclusion_promotion_requests_create",
    resourceType: "approval_request",
    resourceId: replacement.approvalRequest.id,
    approvalRequestId: replacement.approvalRequest.id,
    runId: f.run.id,
    outcome: "pending",
    targetVersion: replacement.approvalRequest.target.version,
    requestId: "request_replacement",
    actorRef: OWNER,
    actorVia: "anonymous",
    environmentId: f.fx.environmentId,
  });
  expect((await replace()).status).toBe(200);
  expect((await auditRows(ctx.repo, f.fx.appId)).slice(before.length)).toEqual(rows);
  const id = replacement.approvalRequest.id;
  const applied = await auditRequest({
    app: f.app,
    jwt: f.fx.jwt,
    path: `/apps/${f.fx.appId}/approval-requests/${id}/reviews`,
    requestId: "request_winner-review",
    idempotencyKey: "winner-review",
    body: {
      action: "approve_and_apply",
      idempotency_key: "winner-review",
      reason: CANARIES.reason,
    },
  });
  expect(applied.status, await applied.clone().text()).toBe(200);
  const request = await ctx.repo.approvals.getRequest(appScope(f.fx.appId), id);
  const review = await ctx.repo.approvals.latestReview(appScope(f.fx.appId), id);
  rows = (await auditRows(ctx.repo, f.fx.appId)).slice(before.length);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    action: "approval_request_reviews_create",
    outcome: "applied",
    approvalRequestId: id,
    resourceId: id,
    runId: f.run.id,
    requestId: "request_winner-review",
  });
  expect(JSON.parse(rows[1]?.changesJson ?? "null")).toMatchObject({
    reviewId: review?.id,
    resultingTargetVersion: request?.resultingTargetVersion,
  });
  expect((await ctx.repo.flags.getFlagConfig(f.scope, f.fx.flag.id))?.version).toBe(
    config.version + 1,
  );
  expectPrivateAudit(rows, f.fx.jwt);
});

it("does not append a fact or create a Conclusion/Request for a stale target refusal", async () => {
  const f = await auditConclusionFixture(ctx);
  const before = await auditRows(ctx.repo, f.fx.appId);
  const response = await f.conclude({
    target: { ...f.body.target, expectedConfigVersion: f.body.target.expectedConfigVersion + 1 },
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "TARGET_CONFIGURATION_STALE" });
  expect(await auditRows(ctx.repo, f.fx.appId)).toEqual(before);
  expect(await ctx.repo.experiments.getRun(f.scope, f.run.id)).toMatchObject({
    status: "running",
  });
  expect(await ctx.repo.approvals.countRequests(appScope(f.fx.appId), {})).toBe(0);
  expect(
    await ctx.repo.experimentConclusions.getByActorKey(
      appScope(f.fx.appId),
      OWNER,
      "conclude-audit",
    ),
  ).toBeNull();
});

it("records Conclusion, Request and applied Review from one inline Conclude call", async () => {
  const f = await auditConclusionFixture(ctx);
  const before = await auditRows(ctx.repo, f.fx.appId);
  const response = await f.conclude({ review: { action: "approve_and_apply" } });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as ConcludeRunResponse;
  expect(body.approvalRequest.status).toBe("applied");
  const rows = (await auditRows(ctx.repo, f.fx.appId)).slice(before.length);
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => [row.action, row.resourceType, row.outcome])).toEqual([
    ["runs_conclude", "run", "committed"],
    ["runs_conclude", "approval_request", "pending"],
    ["approval_request_reviews_create", "approval_request", "applied"],
  ]);
  for (const row of rows)
    expect(row).toMatchObject({
      runId: f.run.id,
      approvalRequestId: body.approvalRequest.id,
      requestId: "request_conclude-audit",
      actorRef: OWNER,
    });
  expect((await f.conclude({ review: { action: "approve_and_apply" } })).status).toBe(200);
  expect((await auditRows(ctx.repo, f.fx.appId)).slice(before.length)).toEqual(rows);
  expectPrivateAudit(rows, f.fx.jwt);
});

it("rolls back Conclusion, End, Request and both audit records when the second audit insert fails", async () => {
  const f = await auditConclusionFixture(ctx);
  const before = await auditRows(ctx.repo, f.fx.appId);
  await ctx.h.bindings.d1
    .prepare(`CREATE TRIGGER reject_conclusion_request_audit
    BEFORE INSERT ON control_plane_audit_events
    WHEN NEW.action = 'runs_conclude' AND NEW.resource_type = 'approval_request'
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`)
    .run();
  try {
    const response = await f.conclude();
    expect(response.status).toBe(500);
    expect(await auditRows(ctx.repo, f.fx.appId)).toEqual(before);
    expect(await ctx.repo.experiments.getRun(f.scope, f.run.id)).toMatchObject({
      status: "running",
      endedAt: null,
    });
    expect(await ctx.repo.experiments.getExperiment(f.scope, f.draft.id)).toMatchObject({
      liveRunId: f.run.id,
    });
    expect(await ctx.repo.approvals.countRequests(appScope(f.fx.appId), {})).toBe(0);
    expect(
      await ctx.repo.experimentConclusions.getByActorKey(
        appScope(f.fx.appId),
        OWNER,
        "conclude-audit",
      ),
    ).toBeNull();
  } finally {
    await ctx.h.bindings.d1.prepare("DROP TRIGGER reject_conclusion_request_audit").run();
  }
  // Removing the fault permits the same intent to commit the complete batch.
  expect((await f.conclude()).status).toBe(200);
  expect((await auditRows(ctx.repo, f.fx.appId)).slice(before.length)).toHaveLength(2);
});
