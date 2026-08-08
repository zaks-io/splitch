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
});

function finalize(appId: string, requestId: string, reviewCount: number): Promise<void> {
  return h.repo.approvals.finalizeArchive(
    appScope(appId),
    { requestId, resolvedAt: OLD, reviewCount },
    "declined",
  );
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
