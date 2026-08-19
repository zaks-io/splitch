import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids } from "../src/config-store-harness-core";
import { approvalRowCounts, seedApprovalArchiveFixture } from "./approval-archive-fixture";
import { makePoolHarness } from "./config-store-pool-harness";

const OLD = "2026-05-01T12:00:00.000Z";
let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("Approval Request archive finalization App scope", () => {
  it("keeps another App's Request intact when finalization receives the wrong scope", async () => {
    const requestId = "apr_01J00000000000000000000113";
    await seedApprovalArchiveFixture(h.d1, {
      id: requestId,
      appId: ids.otherAppId,
      environmentId: "env_archive_other",
      targetId: "flag_config_archive_other",
      targetVersion: `sha256:${"b".repeat(64)}`,
      proposedBy: "user_archive_other",
      proposedVia: "device_flow",
      reviewedBy: "deleted-user:user_archive_other",
      resolvedAt: OLD,
    });

    await expect(finalize(ids.appId, requestId, 2)).rejects.toThrow("archive finalization failed");
    expect(await approvalRowCounts(h.d1, ids.otherAppId, requestId)).toEqual({
      requests: 1,
      reviews: 2,
    });
  });

  it("rolls back every scoped delete when another App has a colliding Review foreign key", async () => {
    const requestId = "apr_01J00000000000000000000115";
    await seedApprovalArchiveFixture(h.d1, { id: requestId, resolvedAt: OLD });
    await seedCollidingReview(requestId);

    await expect(finalize(ids.appId, requestId, 2)).rejects.toThrow(
      "FOREIGN KEY constraint failed",
    );
    expect(await approvalRowCounts(h.d1, ids.appId, requestId)).toEqual({
      requests: 1,
      reviews: 2,
    });
    expect(await approvalRowCounts(h.d1, ids.otherAppId, requestId)).toEqual({
      requests: 0,
      reviews: 1,
    });
  });

  it("keeps a colliding foreign Review when finalization receives its App scope", async () => {
    const requestId = "apr_01J00000000000000000000116";
    await seedApprovalArchiveFixture(h.d1, { id: requestId, resolvedAt: OLD });
    await seedCollidingReview(requestId);

    await expect(finalize(ids.otherAppId, requestId, 1)).rejects.toThrow(
      "archive finalization failed",
    );
    expect(await approvalRowCounts(h.d1, ids.otherAppId, requestId)).toEqual({
      requests: 0,
      reviews: 1,
    });
  });

  // These two cover the TOCTOU guard on the `approval_requests` delete itself
  // (approval-finalization.ts:43): a Request whose status or resolved_at moved
  // between the archive snapshot and finalization must not be deleted. Reviews
  // are stripped first so the request row's own predicate is the only thing
  // standing between "survives" and "deleted" — with reviews still present,
  // the `NOT EXISTS` review guard masks a broken predicate here as
  // defense-in-depth from the mirrored check in the reviews delete (:24).
  it("keeps the Request intact when finalization receives a mismatched expectedStatus", async () => {
    const requestId = "apr_01J00000000000000000000117";
    await seedApprovalArchiveFixture(h.d1, { id: requestId, resolvedAt: OLD });
    await stripReviews(requestId);

    await expect(
      h.repo.approvals.finalizeArchive(
        appScope(ids.appId),
        { requestId, resolvedAt: OLD, reviewCount: 0 },
        "applied",
      ),
    ).rejects.toThrow("archive finalization failed");
    expect(await approvalRowCounts(h.d1, ids.appId, requestId)).toEqual({
      requests: 1,
      reviews: 0,
    });
  });

  it("keeps the Request intact when finalization receives a mismatched resolvedAt", async () => {
    const requestId = "apr_01J00000000000000000000118";
    await seedApprovalArchiveFixture(h.d1, { id: requestId, resolvedAt: OLD });
    await stripReviews(requestId);

    await expect(
      h.repo.approvals.finalizeArchive(
        appScope(ids.appId),
        { requestId, resolvedAt: "2026-06-01T00:00:00.000Z", reviewCount: 0 },
        "declined",
      ),
    ).rejects.toThrow("archive finalization failed");
    expect(await approvalRowCounts(h.d1, ids.appId, requestId)).toEqual({
      requests: 1,
      reviews: 0,
    });
  });
});

function finalize(appId: string, requestId: string, reviewCount: number): Promise<void> {
  return h.repo.approvals.finalizeArchive(
    appScope(appId),
    { requestId, resolvedAt: OLD, reviewCount },
    "declined",
  );
}

async function stripReviews(requestId: string): Promise<void> {
  await h.d1
    .prepare("DELETE FROM approval_reviews WHERE app_id = ? AND approval_request_id = ?")
    .bind(ids.appId, requestId)
    .run();
}

async function seedCollidingReview(requestId: string): Promise<void> {
  await h.d1
    .prepare(
      `INSERT INTO approval_reviews (
        id, app_id, approval_request_id, action, outcome, reviewed_by,
        reviewed_via, reviewed_at, reason, idempotency_key, request_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `rev_${requestId.slice(4)}_foreign`,
      ids.otherAppId,
      requestId,
      "decline",
      "declined",
      "user_archive_collision",
      "device_flow",
      OLD,
      "cross-App collision fixture",
      `idem_${requestId}_foreign`,
      `sha256:${"f".repeat(64)}`,
    )
    .run();
}
