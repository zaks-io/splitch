import { type ApprovalCommit, appScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  AUDIT_APP,
  type CredentialMembershipAuditFixture,
  makeCredentialMembershipAuditFixture,
  OWNER,
} from "./credential-membership-audit-fixture";

let fixture: CredentialMembershipAuditFixture;
beforeEach(async () => {
  fixture = await makeCredentialMembershipAuditFixture();
});
afterEach(async () => {
  await fixture?.dispose();
});

it("commits a Segment's applied Approval outcome and audit in one D1 batch", async () => {
  const scope = appScope(AUDIT_APP);
  const changedAt = "2026-10-16T12:00:00.000Z";
  const pending = await fixture.repo.approvals.createRequest(scope, {
    id: "apr_segment_audit",
    operation: "segments_update",
    targetType: "segment",
    targetId: "segment_audit",
    targetVersion: "segment-version-1",
    policyContexts: "[]",
    diff: JSON.stringify({ current: {}, proposed: {} }),
    status: "pending",
    proposedBy: OWNER,
    proposedVia: "device_flow",
    proposedAt: changedAt,
    idempotencyKey: "segment-proposal-audit",
    requestHash: "sha256:segment-proposal",
  });
  expect(pending.ok).toBe(true);
  const commit: ApprovalCommit = {
    requestId: "apr_segment_audit",
    reviewId: "arv_segment_audit",
    action: "approve_and_apply",
    reviewedBy: OWNER,
    reviewedVia: "device_flow",
    reviewedAt: changedAt,
    reason: null,
    idempotencyKey: "segment-review-audit",
    requestHash: "sha256:segment-review",
    resultingTargetVersion: "segment-version-2",
    resultingResourceType: "segment",
    resultingResourceId: "segment_audit",
    policyContexts: [],
    audit: { actorRef: OWNER, actorVia: "device_flow", requestId: "http_review", changedAt },
  };
  const before = await fixture.events();
  await fixture.failAuditInsert();
  await expect(fixture.repo.approvals.recordApplied(scope, commit)).rejects.toMatchObject({
    cause: { message: expect.stringContaining("test audit insert refused") },
  });
  expect(await fixture.repo.approvals.getRequest(scope, commit.requestId)).toMatchObject({
    status: "pending",
    resolvedAt: null,
  });
  expect(await fixture.repo.approvals.latestReview(scope, commit.requestId)).toBeNull();
  expect(await fixture.events()).toEqual(before);

  await fixture.d1.exec("DROP TRIGGER reject_test_audit");
  expect(await fixture.repo.approvals.recordApplied(scope, commit)).toBe(true);
  expect(await fixture.repo.approvals.getRequest(scope, commit.requestId)).toMatchObject({
    status: "applied",
    resultingTargetVersion: commit.resultingTargetVersion,
  });
  expect(await fixture.repo.approvals.latestReview(scope, commit.requestId)).toMatchObject({
    id: commit.reviewId,
    outcome: "applied",
  });
  const events = await fixture.events();
  expect(events.slice(before.length)).toMatchObject([
    {
      action: "approval_request_reviews_create",
      outcome: "applied",
      approvalRequestId: commit.requestId,
      requestId: "http_review",
    },
  ]);
  expect(JSON.parse(events.at(-1)?.changesJson ?? "null")).toMatchObject({
    reviewId: commit.reviewId,
    resultingTargetVersion: commit.resultingTargetVersion,
  });
  expect(await fixture.repo.approvals.recordApplied(scope, commit)).toBe(false);
  expect(await fixture.events()).toEqual(events);
});
