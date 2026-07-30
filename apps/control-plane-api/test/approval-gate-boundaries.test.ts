import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import { type Harness, ids, setProdPolicy, token } from "../src/config-store-harness-core";
import {
  allowPolicy,
  clearFrozenRun,
  confirmPolicy,
  countApprovalReviews,
  outOfContractPolicy,
  patchConfig,
  patchVariant,
  readRequest,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  // The fixture ships `[]` (never narrowed), matching `ensureInitialFlagConfig`.
  // This suite asserts on the available-Variant list itself, so it narrows
  // explicitly instead of leaning on a fixture default.
  await narrowSeededAvailability(h.d1);
  await setProdPolicy(h, confirmPolicy);
  await clearFrozenRun(h);
});

afterEach(async () => {
  await h.dispose();
});

describe("a failed apply on the targeting-rule path rolls back completely", () => {
  it("leaves rules, config version, and request status untouched", async () => {
    const jwt = await token(h.signer);
    const propose = await h.app.request(
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/targeting-rules`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "idempotency-key": "idem_c5",
        },
        body: JSON.stringify({
          idempotency_key: "idem_c5",
          targetingRules: [
            {
              id: "rule_attack_c5",
              flagId: ids.flagId,
              environmentId: ids.environmentId,
              priority: 0,
              conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
              variantId: ids.treatmentVariantId,
            },
          ],
        }),
      },
    );
    const body = (await propose.json()) as { details?: { approvalRequestId?: string } };
    const requestId = body.details?.approvalRequestId;
    expect(requestId).toBeTruthy();

    // Force the apply to fail mid-flight: remove the Variant the rule needs.
    await h.repo.flags.removeVariant(appScope(ids.appId), ids.flagId, "treatment");
    await reviewRequest(h, requestId as string, "idem_c5r");

    const rules = await h.d1
      .prepare("SELECT id FROM targeting_rules WHERE app_id = ? AND environment_id = ?")
      .bind(ids.appId, ids.environmentId)
      .all();
    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    const row = await h.repo.approvals.getRequest(appScope(ids.appId), requestId as string);
    const latest = await h.repo.approvals.latestReview(appScope(ids.appId), requestId as string);
    expect(rules.results.length).toBe(0);
    expect(config?.version).toBe(1);
    expect(row?.status).toBe("pending");
    expect(latest?.outcome).toBe("failed");
  });
});

describe("ungated writes create no Approval rows", () => {
  it("an allow-policy config change records no Approval Request or Review", async () => {
    await setProdPolicy(h, allowPolicy);
    const response = await patchConfig(h, "idem_c6", { enabled: true });
    expect(response.status).toBe(200);

    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(config?.enabled).toBe(true);
    expect(await h.repo.approvals.countRequests(appScope(ids.appId), {})).toBe(0);
    expect(await countApprovalReviews(h)).toBe(0);
  });

  it("kill-switch-off is ungated even when enabledState is confirm", async () => {
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
      enabled: true,
      updatedAt: "2026-07-02T09:00:00.000Z",
    });
    const response = await patchConfig(h, "idem_c6b", { enabled: false });
    expect(response.status).toBe(200);

    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(config?.enabled).toBe(false);
    expect(await h.repo.approvals.countRequests(appScope(ids.appId), {})).toBe(0);
    expect(await countApprovalReviews(h)).toBe(0);
  });
});

describe("a replay of a resolved Approval Request is not a successful write", () => {
  it("a declined proposal replays as APPROVAL_REQUEST_RESOLVED, not 200", async () => {
    const proposed = await patchConfig(h, "idem_c9", { availableVariantNames: ["control"] });
    expect(proposed.status).toBe(409);
    const requestId = proposed.approvalRequestId as string;
    const declined = await reviewRequest(h, requestId, "idem_c9r", "decline");
    expect(declined.status).toBe(200);

    // Same actor, same key, same payload: the retry must not read back the live
    // Configuration and present it as the result of a change that was refused.
    const replay = await patchConfig(h, "idem_c9", { availableVariantNames: ["control"] });
    expect(replay.status).toBe(409);
    expect(replay.code).toBe("APPROVAL_REQUEST_RESOLVED");

    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(config?.version).toBe(1);
  });
});

describe("a stored proposal that cannot be read is a recorded failure, not a thrown fault", () => {
  it("records VALIDATION_ERROR / MALFORMED_APPROVAL_PROPOSAL and applies nothing", async () => {
    const proposed = await patchVariant(h, "treatment", "idem_c11", { value: "corrupted" });
    expect(proposed.status).toBe(409);
    const requestId = proposed.approvalRequestId as string;

    // A row only reachable by bypassing the write API: the proposal parses as an
    // ApprovalDiff but its `name` is not a string, so the applier cannot read it.
    const row = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    const diff = JSON.parse(row?.diff ?? "{}") as { proposed: Record<string, unknown> };
    diff.proposed.name = 42;
    await h.d1
      .prepare("UPDATE approval_requests SET diff = ? WHERE id = ?")
      .bind(JSON.stringify(diff), requestId)
      .run();

    const reviewed = await reviewRequest(h, requestId, "idem_c11r");
    expect(reviewed.status).toBe(409);
    expect(await reviewed.json()).toMatchObject({ code: "APPROVAL_APPLICATION_FAILED" });

    const latest = await h.repo.approvals.latestReview(appScope(ids.appId), requestId);
    expect(latest?.outcome).toBe("failed");
    expect(latest?.errorCode).toBe("VALIDATION_ERROR");
    expect(JSON.parse(latest?.errorDetails ?? "{}")).toMatchObject({
      field: "name",
      reason: "MALFORMED_APPROVAL_PROPOSAL",
    });

    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.value).toBe(JSON.stringify("on"));
  });
});

describe("an out-of-contract stored Environment Policy fails closed and diagnosably", () => {
  it("names the offending field instead of surfacing an anonymous runtime fault", async () => {
    const proposed = await patchConfig(h, "idem_c7", { availableVariantNames: ["control"] });
    const requestId = proposed.approvalRequestId as string;
    expect(requestId).toBeTruthy();

    await h.d1
      .prepare("UPDATE environments SET policy = ? WHERE id = ?")
      .bind(JSON.stringify(outOfContractPolicy), ids.environmentId)
      .run();

    const read = await readRequest(h, requestId);
    expect(read.status).toBe(500);
    expect(read.body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(read.body.message).toContain("stored Environment Policy is out of contract");
    expect(read.body.message).toContain("variantAvailability");

    const reviewed = await reviewRequest(h, requestId, "idem_c7r");
    expect(reviewed.status).toBe(500);
    expect(((await reviewed.json()) as { code: string }).code).toBe("INTERNAL_SERVER_ERROR");

    // Fails closed: nothing was applied.
    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(config?.version).toBe(1);
  });

  it("funnels a policy column that is not JSON at all into the same named fault", async () => {
    await h.d1
      .prepare("UPDATE environments SET policy = ? WHERE id = ?")
      .bind("{not json", ids.environmentId)
      .run();

    const patched = await patchConfig(h, "idem_c10", { availableVariantNames: ["control"] });
    expect(patched.status).toBe(500);
    expect(patched.code).toBe("INTERNAL_SERVER_ERROR");
    expect(patched.message).toContain("stored Environment Policy is out of contract");
    expect(patched.message).toContain("not valid JSON");

    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(config?.version).toBe(1);
  });

  it("names it on the gated mutation routes too, not only the Approval routes", async () => {
    await h.d1
      .prepare("UPDATE environments SET policy = ? WHERE id = ?")
      .bind(JSON.stringify(outOfContractPolicy), ids.environmentId)
      .run();

    const patched = await patchConfig(h, "idem_c8", { availableVariantNames: ["control"] });
    expect(patched.status).toBe(500);
    expect(patched.code).toBe("INTERNAL_SERVER_ERROR");
    expect(patched.message).toContain("stored Environment Policy is out of contract");

    const config = await h.repo.flags.getFlagConfig(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(config?.version).toBe(1);
  });
});
