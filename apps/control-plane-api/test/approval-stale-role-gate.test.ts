import { ApprovalPolicyContextSchema } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareAndApplyApproval } from "../src/approval-review-application";
import type { ApprovalServiceDeps, ReviewApprovalInput } from "../src/approval-service-types";
import { type Harness, ids, setProdPolicy } from "../src/config-store-harness-core";
import { seedAppMember } from "../src/test-seeds";
import { clearFrozenRun, confirmPolicy, patchVariant } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * `prepareAndApplyApproval` is an EXPORTED entry point. The review route checks
 * the reviewer's role before calling it, but nothing in the type system or the
 * call itself requires that, so the reconciliation branch it reaches on a lost
 * apply re-checks the role before resolving the Request as stale.
 *
 * This suite calls that entry point directly with a non-admin principal — the
 * route's role check "removed" — and pins the outcome. Without the gate the same
 * call falls through to the failure recorder and answers
 * `APPROVAL_APPLICATION_FAILED` (500), telling a member their review broke the
 * server instead of that they may not review at all.
 */

const MEMBER_ID = "user_stale_gate_member";
const NOW = "2026-07-03T18:00:00.000Z";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await clearFrozenRun(h);
  await seedAppMember(h.d1, { appId: ids.appId, userId: MEMBER_ID, role: "member" });
});

afterEach(async () => {
  await h.dispose();
});

function memberPrincipal(): Principal {
  return {
    kind: "control-plane-token",
    id: MEMBER_ID,
    scopes: [],
    orgId: null,
    appId: ids.appId,
    environmentId: null,
    authDoor: "anonymous",
  };
}

/**
 * The apply lost: the guarded write selected zero rows and reports `notApplied`,
 * which is what puts the service on the reconciliation branch under test.
 */
const deps = (repo: Harness["repo"]): ApprovalServiceDeps => ({
  repo,
  nowIso: () => NOW,
  applyOther: async () => ({ ok: false, notApplied: true }),
});

async function pendingVariantRequest(): Promise<string> {
  const proposed = await patchVariant(h, "treatment", "idem_stale_gate", { value: '"gated"' });
  expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");
  const requestId = proposed.approvalRequestId;
  if (!requestId) throw new Error("seed: no Approval Request id was returned");
  return requestId;
}

describe("the reconciliation branch re-checks the reviewer role", () => {
  it("refuses a non-admin with ROLE_NOT_ALLOWED and resolves nothing", async () => {
    const requestId = await pendingVariantRequest();
    const row = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    if (!row) throw new Error("missing Approval Request");
    const input: ReviewApprovalInput = {
      appId: ids.appId,
      approvalRequestId: row.id,
      action: "approve_and_apply",
      reason: null,
      idempotencyKey: "idem_stale_gate_review",
      principal: memberPrincipal(),
      requestId: "req_stale_gate",
    };

    const result = await prepareAndApplyApproval(
      deps(h.repo),
      row,
      input,
      `sha256:${"2".repeat(64)}`,
      NOW,
      ApprovalPolicyContextSchema.array().parse(JSON.parse(row.policyContexts)),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toMatchObject({
      code: "APPROVAL_REVIEW_FORBIDDEN",
      details: { reason: "ROLE_NOT_ALLOWED" },
    });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
    });
    expect(await h.repo.approvals.latestReview(appScope(ids.appId), requestId)).toBeNull();
  });
});
