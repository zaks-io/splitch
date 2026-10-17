import {
  type AppAuditEvent,
  AppAuditListResponseSchema,
  type ConcludeRunResponse,
} from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { expect } from "vitest";
import { forwardAuditEvents } from "../src/audit-events";
import {
  type ExperimentRunHarness,
  makeExperimentRunHarness,
} from "../src/experiment-run-test-fixture";
import { OWNER } from "../src/flag-definition-test-harness";
import { makeLocalBindings } from "../src/test-fixtures";
import { auditConclusionFixture } from "./app-audit-conclusion-fixture";
import { auditRequest, auditRows, CANARIES } from "./app-audit-mutation-fixture";
import { makeAuditTinybirdReader } from "./audit-tinybird-fixture";

type ConclusionFixture = Awaited<ReturnType<typeof auditConclusionFixture>>;

export async function proveAuditConclusionRead() {
  const ctx = await makeExperimentRunHarness(makeLocalBindings);
  try {
    const f = await auditConclusionFixture(ctx);
    const committed = await commitConclusionReview(ctx, f);
    const app = await ctx.repo.identity.getApp(f.fx.appId);
    if (!app) throw new Error("Expected the Conclusion's committed App");
    const reader = makeAuditTinybirdReader({
      bindings: ctx.h.bindings,
      repo: ctx.repo,
      principal: {
        id: OWNER,
        kind: "control-plane-token",
        scopes: [`app:${f.fx.appId}:owner`],
        orgId: app.organizationId,
        appId: f.fx.appId,
        environmentId: null,
        authDoor: "anonymous",
      },
    });
    const outbox = await auditRows(ctx.repo, f.fx.appId);
    expect(
      await forwardAuditEvents({ repo: ctx.repo, env: reader.env, scope: appScope(f.fx.appId) }),
    ).toBe(outbox.length);
    const query = new URLSearchParams({
      approvalRequestId: committed.request.id,
      runId: f.run.id,
      limit: "100",
    });
    const response = await reader.app.request(`/apps/${f.fx.appId}/audit?${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const page = AppAuditListResponseSchema.parse(await response.json());
    expect(page.cursor).toBeNull();
    expect(reader.readCalls).toEqual(["/v0/pipes/app_audit_events.json"]);
    expectCorrelatedEvents(page.items, f, committed, app.organizationId);
    expect(page.items.map((event) => event.eventId).sort()).toEqual(
      outbox
        .filter((row) => row.approvalRequestId === committed.request.id)
        .map((row) => row.eventId)
        .sort(),
    );
    for (const canary of [...Object.values(CANARIES), f.fx.jwt]) {
      expect(JSON.stringify({ outbox, items: page.items })).not.toContain(canary);
    }
  } finally {
    await ctx.h.bindings.dispose();
  }
}

async function commitConclusionReview(ctx: ExperimentRunHarness, f: ConclusionFixture) {
  const initial = await f.conclude();
  expect(initial.status, await initial.clone().text()).toBe(200);
  const concluded = (await initial.json()) as ConcludeRunResponse;
  expect(concluded.approvalRequest.status).toBe("pending");
  const requestId = concluded.approvalRequest.id;
  const reviewResponse = await auditRequest({
    app: f.app,
    jwt: f.fx.jwt,
    path: `/apps/${f.fx.appId}/approval-requests/${requestId}/reviews`,
    requestId: "request_tinybird-review",
    idempotencyKey: "tinybird-review",
    body: {
      action: "approve_and_apply",
      idempotency_key: "tinybird-review",
      reason: CANARIES.reason,
    },
  });
  expect(reviewResponse.status, await reviewResponse.clone().text()).toBe(200);
  const scope = appScope(f.fx.appId);
  const request = await ctx.repo.approvals.getRequest(scope, requestId);
  const review = await ctx.repo.approvals.latestReview(scope, requestId);
  const config = await ctx.repo.flags.getFlagConfig(f.scope, f.fx.flag.id);
  const run = await ctx.repo.experiments.getRun(f.scope, f.run.id);
  const conclusion = await ctx.repo.experimentConclusions.get(
    f.scope,
    f.draft.id,
    f.run.id,
    concluded.conclusion.id,
  );
  if (!request || !review || !config || !run || !conclusion)
    throw new Error("Expected committed Conclusion, Request, Review, Configuration and Run");
  expect(request).toMatchObject({
    status: "applied",
    resultingResourceType: "flag_configuration",
    resultingResourceId: config.id,
  });
  expect(review).toMatchObject({ outcome: "applied", reviewedBy: OWNER });
  expect(config).toMatchObject({
    version: f.body.target.expectedConfigVersion + 1,
    enabled: false,
  });
  expect(run).toMatchObject({ id: f.run.id, status: "ended", configHash: f.run.configHash });
  expect(conclusion).toMatchObject({ runId: run.id, reason: CANARIES.reason });
  expect(request.targetVersion).toBe(concluded.approvalRequest.target.version);
  expect(request.resultingTargetVersion).toEqual(expect.any(String));
  expect(request.resultingTargetVersion).not.toBe(request.targetVersion);
  return { request, review, config, run };
}

function expectCorrelatedEvents(
  items: AppAuditEvent[],
  f: ConclusionFixture,
  committed: Awaited<ReturnType<typeof commitConclusionReview>>,
  organizationId: string,
) {
  expect(items).toHaveLength(3);
  for (const event of items) {
    expect(event).toMatchObject({
      appId: f.fx.appId,
      environmentId: f.fx.environmentId,
      organizationId,
      actor: { type: "user", userId: OWNER },
      authDoor: "anonymous",
      approvalRequestId: committed.request.id,
      runId: committed.run.id,
    });
  }
  expect(items.find((event) => event.resourceType === "run")).toMatchObject({
    action: "runs_conclude",
    resourceId: committed.run.id,
    targetVersion: committed.run.configHash,
    outcome: "committed",
    requestId: "request_conclude-audit",
  });
  expect(items.find((event) => event.outcome === "pending")).toMatchObject({
    action: "runs_conclude",
    resourceType: "approval_request",
    resourceId: committed.request.id,
    targetVersion: committed.request.targetVersion,
    requestId: "request_conclude-audit",
  });
  expect(items.find((event) => event.action === "approval_request_reviews_create")).toMatchObject({
    resourceType: "approval_request",
    resourceId: committed.request.id,
    targetVersion: committed.request.targetVersion,
    outcome: "applied",
    requestId: "request_tinybird-review",
    metadata: {
      reviewId: committed.review.id,
      reviewAction: "approve_and_apply",
      resultingTargetVersion: committed.request.resultingTargetVersion,
      errorCode: null,
    },
  });
}
