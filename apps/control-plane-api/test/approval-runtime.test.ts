import { ApprovalRequestSchema } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/approval-canonical";
import {
  type Harness,
  ids,
  patchFlagConfig,
  setProdPolicy,
  USER_ID,
} from "../src/config-store-harness-core";
import { confirmPolicy, getApprovalRequests, proposeA, reviewRequest } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
});

afterEach(async () => {
  await h.dispose();
});

describe("Approval Request runtime", () => {
  it("persists a proposal and exposes it through list and get", async () => {
    const requestId = await proposeA(h);

    const get = await getApprovalRequests(h, requestId);
    expect(get.status).toBe(200);
    const request = ApprovalRequestSchema.parse(await get.json());
    expect(request).toMatchObject({
      id: requestId,
      appId: ids.appId,
      operation: "flag_config_update",
      status: "pending",
      target: { type: "flag_configuration", id: ids.configId },
      proposer: { userId: USER_ID, authDoor: "anonymous" },
    });
    expect(request.diff.entries).toContainEqual(
      expect.objectContaining({ path: "/availableVariantNames", operation: "replace" }),
    );
    const stored = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    expect(stored?.diff).toBe(canonicalJson(request.diff));

    const list = await getApprovalRequests(
      h,
      undefined,
      "?status=pending&target_kind=flag_configuration",
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [{ id: requestId, status: "pending" }],
      cursor: null,
      // Effective staleness is derived per row on read, so a `pending`/`stale`
      // filter has no honest SQL count and the contract's `total: number | null`
      // reports `null` rather than counting stored status and lying.
      total: null,
    });

    const unfiltered = await getApprovalRequests(h, undefined, "?target_kind=flag_configuration");
    expect(await unfiltered.json()).toMatchObject({
      items: [{ id: requestId, status: "pending" }],
      total: 1,
    });
  });

  it("replays an exact proposal and conflicts on a different proposal under the same key", async () => {
    const requestId = await proposeA(h);
    expect(await proposeA(h)).toBe(requestId);

    const conflict = await patchFlagConfig(h, { enabled: true });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      details: {
        scope: "approval_request",
        idempotencyKey: "idem_config_store_test",
      },
    });
  });

  it("declines durably and replays only an exact Review", async () => {
    const requestId = await proposeA(h);
    const first = await reviewRequest(h, requestId, "idem_review_decline", "decline");
    const firstBody = await first.json();
    expect({ status: first.status, body: firstBody }).toMatchObject({ status: 200 });
    const declined = ApprovalRequestSchema.parse(firstBody);
    expect(declined).toMatchObject({
      id: requestId,
      status: "declined",
      latestReview: { outcome: "declined", action: "decline" },
    });

    const replay = await reviewRequest(h, requestId, "idem_review_decline", "decline");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(declined);

    const conflict = await reviewRequest(h, requestId, "idem_review_decline", "approve_and_apply");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("computes stale on read without mutating, then materializes stale on Review", async () => {
    const requestId = await proposeA(h);
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
      enabled: true,
      updatedAt: "2026-07-01T21:00:00.000Z",
    });

    const read = await getApprovalRequests(h, requestId);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: requestId, status: "stale", resolvedAt: null });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
      resolvedAt: null,
    });

    const reviewed = await reviewRequest(h, requestId, "idem_review_stale", "approve_and_apply");
    const reviewedBody = await reviewed.json();
    expect({ status: reviewed.status, body: reviewedBody }).toMatchObject({ status: 409 });
    expect(reviewedBody).toMatchObject({
      code: "APPROVAL_REQUEST_STALE",
      details: { approvalRequestId: requestId },
    });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "stale",
      resolvedAt: expect.any(String),
    });
  });

  it("records a failed Review, rolls back, and permits a new idempotent retry", async () => {
    const requestId = await proposeA(h);
    await h.repo.flags.removeVariant(appScope(ids.appId), ids.flagId, "control");

    const failed = await reviewRequest(h, requestId, "idem_review_failed", "approve_and_apply");
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({
      code: "APPROVAL_APPLICATION_FAILED",
      details: {
        approvalRequestId: requestId,
        applicationError: {
          code: "VARIANT_NOT_AVAILABLE",
          details: {
            flagId: ids.flagId,
            environmentId: ids.environmentId,
            missingVariants: ["control"],
          },
        },
      },
    });
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ version: 1 });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "pending",
      resolvedAt: null,
    });

    await h.repo.flags.addVariant(appScope(ids.appId), ids.flagId, {
      id: ids.controlVariantId,
      name: "control",
      value: JSON.stringify("off"),
      createdAt: "2026-07-01T20:00:00.000Z",
    });
    const retried = await reviewRequest(h, requestId, "idem_review_retry", "approve_and_apply");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      id: requestId,
      status: "applied",
      latestReview: { outcome: "applied" },
    });
  });
});
