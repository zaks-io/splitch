import { canonicalHash } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy } from "../src/config-store-harness-core";
import {
  allowAllPolicies,
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  request,
} from "../src/flag-definition-test-harness";
import {
  clearFrozenRun,
  confirmPolicy,
  deleteFlagRequest,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

describe("flags_delete codeRemoval claim (direct path)", () => {
  let h: FlagDefinitionHarness;

  beforeEach(async () => {
    h = await makeFlagDefinitionHarness(makeLocalBindings);
  });

  afterEach(async () => h.bindings.dispose());

  async function ownerSession() {
    const created = await createDefaultApp(h);
    return { appId: created.app.id, jwt: await appToken(h, created.app.id) };
  }

  it("records an explicit unknown claim when codeRemoval is omitted", async () => {
    const { appId, jwt } = await ownerSession();
    await allowAllPolicies(h, appId);
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "to-delete-unknown",
      lifecycleClass: "ops",
    });

    const deleted = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${flag.id}`,
      jwt,
      undefined,
      "del-unknown-1",
    );
    expect(deleted.status).toBe(200);

    const changes = await request(h, "GET", `/apps/${appId}/flag-changes?flagId=${flag.id}`, jwt);
    const items = (
      (await changes.json()) as {
        items: Array<{ action: string; diff: { after: Record<string, unknown> | null } }>;
      }
    ).items;
    expect(items.find((item) => item.action === "deleted")?.diff.after).toMatchObject({
      codeRemoval: { state: "unknown" },
    });
  });

  it("stores a claimed codeRemoval reference on the deletion audit row", async () => {
    const { appId, jwt } = await ownerSession();
    await allowAllPolicies(h, appId);
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "to-delete-claimed",
      lifecycleClass: "ops",
    });

    const deleted = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${flag.id}`,
      jwt,
      { codeRemoval: { reference: "https://example.com/pr/99", state: "claimed" } },
      "del-claimed-1",
    );
    expect(deleted.status).toBe(200);

    const changes = await request(h, "GET", `/apps/${appId}/flag-changes?flagId=${flag.id}`, jwt);
    const items = (
      (await changes.json()) as {
        items: Array<{ action: string; diff: { after: Record<string, unknown> | null } }>;
      }
    ).items;
    expect(items.find((item) => item.action === "deleted")?.diff.after).toMatchObject({
      codeRemoval: { state: "claimed", reference: "https://example.com/pr/99" },
    });
  });

  it("rolls back the direct delete when the claim audit write cannot land", async () => {
    const { appId, jwt } = await ownerSession();
    await allowAllPolicies(h, appId);
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "audit-fail-direct",
      lifecycleClass: "ops",
    });
    // Without the deletion audit row, the in-batch claim UPDATE misses and aborts.
    // Empty the audit table too: a FROM flag_change_events guard would otherwise
    // return zero rows and silently skip ELSE json('') (retention + missing trigger).
    await h.bindings.d1.prepare("DROP TRIGGER IF EXISTS flag_change_flag_after_delete").run();
    await h.bindings.d1.prepare("DELETE FROM flag_change_events").run();
    try {
      const deleted = await request(
        h,
        "DELETE",
        `/apps/${appId}/flags/${flag.id}`,
        jwt,
        undefined,
        "del-audit-fail-direct",
      );
      expect(deleted.status).toBeGreaterThanOrEqual(500);

      const repo = createRepository(h.bindings.d1);
      expect(await repo.flags.getFlag(appScope(appId), flag.id)).toBeTruthy();
      const brief = await request(h, "GET", `/apps/${appId}/flags/${flag.id}/removal-brief`, jwt);
      expect(brief.status).toBe(200);
      expect(await brief.json()).toMatchObject({ removalSafe: true, keepVariant: "control" });
    } finally {
      await h.bindings.d1
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

  it("replays a bodyless delete without IDEMPOTENCY_KEY_CONFLICT (pre-upgrade fingerprint)", async () => {
    const { appId, jwt } = await ownerSession();
    // Leave prod at confirm so the first DELETE only creates a pending Approval.
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "fingerprint-omit",
      lifecycleClass: "ops",
    });
    const key = "del-fingerprint-omit";
    const first = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${flag.id}`,
      jwt,
      undefined,
      key,
    );
    expect(first.status).toBe(409);
    const firstBody = (await first.json()) as {
      code: string;
      details: { approvalRequestId: string };
    };
    expect(firstBody.code).toBe("APPROVAL_REVIEW_REQUIRED");

    const preUpgradeHash = await canonicalHash({
      operation: "flags_delete",
      target: { type: "flag", id: flag.id },
      proposalInput: { flagId: flag.id },
    });
    const row = await createRepository(h.bindings.d1).approvals.getRequest(
      appScope(appId),
      firstBody.details.approvalRequestId,
    );
    expect(row?.requestHash).toBe(preUpgradeHash);

    const retry = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${flag.id}`,
      jwt,
      undefined,
      key,
    );
    expect(retry.status).toBe(409);
    const retryBody = (await retry.json()) as {
      code: string;
      details: { approvalRequestId: string };
    };
    expect(retryBody.code).toBe("APPROVAL_REVIEW_REQUIRED");
    expect(retryBody.code).not.toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(retryBody.details.approvalRequestId).toBe(firstBody.details.approvalRequestId);
  });

  it("rejects a claim fingerprint mismatch after Policy confirm→allow (same Idempotency-Key)", async () => {
    const { appId, jwt } = await ownerSession();
    // Prod ships confirm; first DELETE only creates a pending Approval with claim A.
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "fingerprint-mismatch-policy",
      lifecycleClass: "ops",
    });
    const key = "del-fingerprint-mismatch-policy";
    const claimA = {
      codeRemoval: { reference: "https://example.com/pr/a", state: "claimed" as const },
    };
    const first = await request(h, "DELETE", `/apps/${appId}/flags/${flag.id}`, jwt, claimA, key);
    expect(first.status).toBe(409);
    const firstBody = (await first.json()) as {
      code: string;
      details: { approvalRequestId: string };
    };
    expect(firstBody.code).toBe("APPROVAL_REVIEW_REQUIRED");

    // Policy flip would otherwise let ignoreMismatch fall through to direct delete.
    await allowAllPolicies(h, appId);

    const retryNoClaim = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${flag.id}`,
      jwt,
      undefined,
      key,
    );
    expect(retryNoClaim.status).toBe(409);
    expect(await retryNoClaim.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });

    const claimB = {
      codeRemoval: { reference: "https://example.com/pr/b", state: "claimed" as const },
    };
    const retryClaimB = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${flag.id}`,
      jwt,
      claimB,
      key,
    );
    expect(retryClaimB.status).toBe(409);
    expect(await retryClaimB.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });

    const repo = createRepository(h.bindings.d1);
    expect(await repo.flags.getFlag(appScope(appId), flag.id)).toBeTruthy();
    const pending = await repo.approvals.getRequest(
      appScope(appId),
      firstBody.details.approvalRequestId,
    );
    expect(pending?.status).toBe("pending");
  });
});

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

    // Empty audit history + missing deletion trigger: claim UPDATE hits zero rows
    // and the scalar guard must still abort (not a silent zero-row SELECT).
    await h.d1.prepare("DROP TRIGGER IF EXISTS flag_change_flag_after_delete").run();
    await h.d1.prepare("DELETE FROM flag_change_events").run();
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
      // Pooled D1 reuses the binding across tests; restore the trigger.
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
});
