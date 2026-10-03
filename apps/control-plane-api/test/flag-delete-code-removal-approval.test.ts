import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy } from "../src/config-store-harness-core";
import {
  clearFrozenRun,
  confirmPolicy,
  deleteFlagRequest,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

describe("flags_delete codeRemoval claim (Approval apply path)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makePoolHarness();
    await setProdPolicy(h, confirmPolicy);
    await clearFrozenRun(h);
  });

  afterEach(async () => {
    await h.dispose();
  });

  it("rolls back Approval apply when the claim audit write cannot land", async () => {
    const removed = await deleteFlagRequest(h, "flag_delete_audit_fail");
    expect(removed.status).toBe(409);
    const requestId = removed.approvalRequestId;
    expect(requestId).toBeTruthy();

    // Block audit writes so the claim UPDATE/INSERT cannot land; the guard aborts.
    await h.d1
      .prepare(
        `CREATE TRIGGER block_flag_change_events_insert
         BEFORE INSERT ON flag_change_events
         BEGIN SELECT RAISE(ABORT, 'claim blocked'); END`,
      )
      .run();
    await h.d1
      .prepare(
        `CREATE TRIGGER block_flag_change_events_update
         BEFORE UPDATE ON flag_change_events
         BEGIN SELECT RAISE(ABORT, 'claim blocked'); END`,
      )
      .run();
    try {
      const review = await reviewRequest(h, requestId ?? "", "flag_delete_audit_fail_review");
      // Apply surfaces as APPROVAL_APPLICATION_FAILED (409); the batch rolled back.
      expect(review.status).toBe(409);
      expect(await review.json()).toMatchObject({ code: "APPROVAL_APPLICATION_FAILED" });

      expect(await h.repo.flags.getFlag(appScope(ids.appId), ids.flagId)).toBeTruthy();
      for (const environmentId of [ids.environmentId, ids.devEnvironmentId]) {
        expect(
          await h.repo.flags.getFlagConfig(envScope(ids.appId, environmentId), ids.flagId),
        ).toBeTruthy();
      }
    } finally {
      await h.d1.prepare("DROP TRIGGER IF EXISTS block_flag_change_events_insert").run();
      await h.d1.prepare("DROP TRIGGER IF EXISTS block_flag_change_events_update").run();
    }
  });

  it("records unknown codeRemoval on an approved Flag delete", async () => {
    const removed = await deleteFlagRequest(h, "flag_delete_claim_approved");
    expect(removed.approvalRequestId).toBeTruthy();
    const review = await reviewRequest(
      h,
      removed.approvalRequestId ?? "",
      "flag_delete_claim_review",
    );
    expect(review.status).toBe(200);
    expect(await h.repo.flags.getFlag(appScope(ids.appId), ids.flagId)).toBeNull();

    const events = await h.d1
      .prepare(
        `SELECT diff_json FROM flag_change_events
         WHERE app_id = ? AND flag_id = ? AND action = 'deleted' AND target_type = 'flag'
         ORDER BY seq DESC LIMIT 1`,
      )
      .bind(ids.appId, ids.flagId)
      .first<{ diff_json: string | null }>();
    expect(events?.diff_json).toBeTruthy();
    expect(JSON.parse(events?.diff_json ?? "null")).toMatchObject({
      codeRemoval: { state: "unknown" },
    });
  });

  it("approves Flag deletion end to end when the deletion trigger is absent", async () => {
    // Dark-launch / makeLocalBindings omit flag_change triggers; the claim must
    // still INSERT and the Approval apply must succeed with omitted → unknown.
    const removed = await deleteFlagRequest(h, "flag_delete_triggerless");
    expect(removed.status).toBe(409);
    expect(removed.approvalRequestId).toBeTruthy();

    await h.d1.prepare("DROP TRIGGER IF EXISTS flag_change_flag_after_delete").run();
    await h.d1.prepare("DELETE FROM flag_change_events").run();
    try {
      const review = await reviewRequest(
        h,
        removed.approvalRequestId ?? "",
        "flag_delete_triggerless_review",
      );
      expect(review.status).toBe(200);
      expect(await h.repo.flags.getFlag(appScope(ids.appId), ids.flagId)).toBeNull();

      const events = await h.d1
        .prepare(
          `SELECT diff_json FROM flag_change_events
           WHERE app_id = ? AND flag_id = ? AND action = 'deleted' AND target_type = 'flag'
           ORDER BY seq DESC LIMIT 1`,
        )
        .bind(ids.appId, ids.flagId)
        .first<{ diff_json: string | null }>();
      expect(events?.diff_json).toBeTruthy();
      expect(JSON.parse(events?.diff_json ?? "null")).toMatchObject({
        codeRemoval: { state: "unknown" },
      });
    } finally {
      await h.d1
        .prepare(
          `CREATE TRIGGER IF NOT EXISTS flag_change_flag_after_delete
           AFTER DELETE ON flags
           BEGIN
             INSERT INTO flag_change_events (
               app_id, environment_id, flag_id, flag_key, action, target_type,
               actor_ref, actor_via, changed_at, diff_json
             ) VALUES (
               OLD.app_id, NULL, OLD.id, OLD.key, 'deleted', 'flag',
               OLD.updated_by, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
             );
           END`,
        )
        .run();
    }
  });
});
