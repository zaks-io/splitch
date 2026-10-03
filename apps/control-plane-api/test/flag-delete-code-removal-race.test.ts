import { type ApprovalCommit, appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy, USER_ID } from "../src/config-store-harness-core";
import {
  allowAllPolicies,
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
} from "../src/flag-definition-test-harness";
import { clearFrozenRun, confirmPolicy, deleteFlagRequest } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";
import {
  flagDeletionAuditRows,
  LOSER_CLAIM,
  legacyDeleteLeavingNullAudit,
  racyRepository,
} from "./flag-delete-code-removal-race";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

describe("flags_delete codeRemoval claim loses to legacy NULL audit", () => {
  describe("direct path", () => {
    let h: FlagDefinitionHarness;

    beforeEach(async () => {
      h = await makeFlagDefinitionHarness(makeLocalBindings);
    });

    afterEach(async () => h.bindings.dispose());

    it("does not patch or insert when Flag DELETE affects zero rows", async () => {
      const created = await createDefaultApp(h);
      const appId = created.app.id;
      const jwt = await appToken(h, appId);
      await allowAllPolicies(h, appId);
      const flag = await createFlag(h, appId, jwt, {
        ...baseFlag(appId),
        key: "legacy-null-race-direct",
        lifecycleClass: "ops",
      });
      const envs = created.environments;

      let legacySeq = -1;
      const racy = racyRepository(h.bindings.d1, async () => {
        legacySeq = (await legacyDeleteLeavingNullAudit(h.bindings.d1, appId, flag.id, flag.key))
          .seq;
      });
      const deleted = await racy.flags.deleteFlagCascade(
        appScope(appId),
        flag.id,
        envs.map((environment) => environment.id),
        { codeRemoval: LOSER_CLAIM },
      );
      expect(deleted).toBe(false);

      const after = await flagDeletionAuditRows(h.bindings.d1, appId, flag.id);
      expect(after.results).toEqual([{ seq: legacySeq, diffJson: null }]);
      expect(JSON.stringify(after.results)).not.toContain("loser-must-not-land");
    });
  });

  describe("Approval apply path", () => {
    let h: Harness;

    beforeEach(async () => {
      h = await makePoolHarness();
      await setProdPolicy(h, confirmPolicy);
      await clearFrozenRun(h);
    });

    afterEach(async () => {
      await h.dispose();
    });

    it("does not patch or insert when Review does not land", async () => {
      const removed = await deleteFlagRequest(h, "flag_delete_legacy_null_race");
      expect(removed.status).toBe(409);
      expect(removed.approvalRequestId).toBeTruthy();
      const pending = await h.repo.approvals.getRequest(
        appScope(ids.appId),
        removed.approvalRequestId ?? "",
      );
      expect(pending?.status).toBe("pending");
      const flag = await h.repo.flags.getFlag(appScope(ids.appId), ids.flagId);
      expect(flag).toBeTruthy();

      const commit: ApprovalCommit = {
        requestId: pending?.id ?? "",
        reviewId: "rev_legacy_null_race",
        action: "approve_and_apply",
        reviewedBy: USER_ID,
        reviewedVia: "session",
        reviewedAt: "2026-07-02T11:22:33.000Z",
        reason: null,
        idempotencyKey: "flag_delete_legacy_null_race_review",
        requestHash: pending?.requestHash ?? "",
        resultingTargetVersion: "deleted",
        resultingResourceType: "flag",
        resultingResourceId: ids.flagId,
        policyContexts: [],
      };

      // Pool reset omits flag_change_events; clear prior tests' deletion history.
      await h.d1
        .prepare(
          `DELETE FROM flag_change_events
           WHERE app_id = ? AND flag_id = ? AND action = 'deleted' AND target_type = 'flag'`,
        )
        .bind(ids.appId, ids.flagId)
        .run();

      let legacySeq = -1;
      const racy = racyRepository(h.d1, async () => {
        legacySeq = (
          await legacyDeleteLeavingNullAudit(h.d1, ids.appId, ids.flagId, flag?.key ?? "")
        ).seq;
      });
      const deleted = await racy.flags.deleteFlagCascade(
        appScope(ids.appId),
        ids.flagId,
        [ids.environmentId, ids.devEnvironmentId],
        { approval: commit, codeRemoval: LOSER_CLAIM },
      );
      expect(deleted).toBe(false);

      const after = await flagDeletionAuditRows(h.d1, ids.appId, ids.flagId);
      expect(after.results).toEqual([{ seq: legacySeq, diffJson: null }]);
      expect(JSON.stringify(after.results)).not.toContain("loser-must-not-land");

      const stillPending = await h.repo.approvals.getRequest(
        appScope(ids.appId),
        removed.approvalRequestId ?? "",
      );
      expect(stillPending?.status).toBe("pending");
      const reviews = await h.d1
        .prepare("SELECT id FROM approval_reviews WHERE id = ?")
        .bind(commit.reviewId)
        .all();
      expect(reviews.results).toHaveLength(0);
    });
  });
});
