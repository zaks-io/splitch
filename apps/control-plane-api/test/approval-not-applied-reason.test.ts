import { env } from "cloudflare:workers";
import type { ApprovalCommit } from "@splitch/db";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyApprovedFlagConfig } from "../src/config-store-approved-write";
import { type Harness, ids, setProdPolicy } from "../src/config-store-harness-core";
import type { ConfigStoreDeps } from "../src/config-store-types";
import { clearFrozenRun, confirmPolicy, proposeA } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * A guarded write that lands nothing and a Flag that does not exist are
 * different facts and must not share a reason code. The approved-write path
 * once answered `FLAG_NOT_FOUND` for both, which reads as "your Flag is gone"
 * when the truth is "your Approval Request stopped being applicable" — a
 * disguised outcome (ADR-0036). `APPROVAL_NOT_APPLIED` is the one the caller's
 * reconciliation branches on, so it is pinned here.
 */

const NOW = "2026-07-03T19:00:00.000Z";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await clearFrozenRun(h);
});

afterEach(async () => {
  await h.dispose();
});

function deps(): ConfigStoreDeps {
  return {
    repo: h.repo,
    kv: env.CONFIG_STORE,
    broadcaster: { broadcast: () => undefined },
    now: () => new Date(NOW),
  };
}

async function proposal(flagId: string) {
  const config = await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), flagId);
  return {
    flagId,
    environmentId: ids.environmentId,
    version: config?.version ?? 1,
    enabled: true,
    availableVariantNames: JSON.parse(config?.availableVariantNames ?? "[]") as string[],
    targetingRules: [],
    rollout: null,
    experiment: null,
  };
}

function commitFor(requestId: string, row: { targetVersion: string; policyContexts: string }) {
  return {
    requestId,
    reviewId: "rev_01J00000000000000000000099",
    action: "approve_and_apply",
    // No App membership row exists for this user, so the D1 reviewer guard
    // filters every statement and the batch lands nothing.
    reviewedBy: "user_not_a_member_at_all",
    reviewedVia: "anonymous",
    reviewedAt: NOW,
    reason: null,
    idempotencyKey: "idem_not_applied",
    requestHash: `sha256:${"3".repeat(64)}`,
    resultingTargetVersion: row.targetVersion,
    resultingResourceType: "flag_configuration",
    resultingResourceId: ids.configId,
    policyContexts: JSON.parse(row.policyContexts) as ApprovalCommit["policyContexts"],
  } satisfies ApprovalCommit;
}

describe("the approved flag-configuration write distinguishes its failure reasons", () => {
  it("reports APPROVAL_NOT_APPLIED when the guarded write lands nothing", async () => {
    const requestId = await proposeA(h);
    const row = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    if (!row) throw new Error("missing Approval Request");

    const result = await applyApprovedFlagConfig(deps(), {
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      proposed: await proposal(ids.flagId),
      diffEntries: [{ path: "/availableVariantNames" }],
      approval: commitFor(requestId, row),
    });

    expect(result).toMatchObject({ ok: false, reason: "APPROVAL_NOT_APPLIED" });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
    });
    expect(await h.repo.approvals.latestReview(appScope(ids.appId), requestId)).toBeNull();
  });

  it("still reports FLAG_NOT_FOUND for a Flag that is genuinely absent", async () => {
    const requestId = await proposeA(h);
    const row = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    if (!row) throw new Error("missing Approval Request");

    const result = await applyApprovedFlagConfig(deps(), {
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: "flag_does_not_exist",
      proposed: { ...(await proposal(ids.flagId)), flagId: "flag_does_not_exist" },
      diffEntries: [{ path: "/availableVariantNames" }],
      approval: commitFor(requestId, row),
    });

    expect(result).toMatchObject({ ok: false, reason: "FLAG_NOT_FOUND" });
  });

  it("refuses a version-only entry set instead of applying an empty patch", async () => {
    const requestId = await proposeA(h);
    const row = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    if (!row) throw new Error("missing Approval Request");

    const result = await applyApprovedFlagConfig(deps(), {
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      proposed: await proposal(ids.flagId),
      diffEntries: [{ path: "/version" }],
      approval: commitFor(requestId, row),
    });

    expect(result).toMatchObject({ ok: false, reason: "APPROVAL_EMPTY_CHANGE" });
  });
});
