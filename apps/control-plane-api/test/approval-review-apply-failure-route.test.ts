import type { ApprovalRequest } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigStoreWriter } from "../src/config-store";
import {
  type Harness,
  ids,
  makeAuthedApp,
  setProdPolicy,
  token,
} from "../src/config-store-harness-core";
import type { FlagConfigWriteResult } from "../src/config-store-types";
import { clearFrozenRun, confirmPolicy, proposeA } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

type ApplyFailure = Extract<FlagConfigWriteResult, { ok: false }>;

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await clearFrozenRun(h);
});

afterEach(async () => {
  await h.dispose();
});

describe("approval Review POST apply-failure responses", () => {
  it("returns CHANGED_FIELDS_UNDETERMINED as a terminal stale Review", async () => {
    const { response, request } = await reviewWithFailure(
      { ok: false, reason: "CHANGED_FIELDS_UNDETERMINED" },
      "idem_review_changed_fields_undetermined",
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Approval Request changed-field set could not be determined; refuse rather than apply",
      details: { fault: "approval_changed_fields_undetermined" },
    });
    expect(request).toMatchObject({
      status: "stale",
      latestReview: {
        outcome: "stale",
        error: {
          code: "INTERNAL_SERVER_ERROR",
          details: { fault: "approval_changed_fields_undetermined" },
        },
      },
    });
  });

  it("returns APPROVAL_EMPTY_CHANGE as a terminal stale Review", async () => {
    const { response, request } = await reviewWithFailure(
      { ok: false, reason: "APPROVAL_EMPTY_CHANGE" },
      "idem_review_empty_change",
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Approval Request does not change any Flag Configuration field that can be applied",
      details: { fault: "approval_empty_change" },
    });
    expect(request).toMatchObject({
      status: "stale",
      latestReview: {
        outcome: "stale",
        error: {
          code: "INTERNAL_SERVER_ERROR",
          details: { fault: "approval_empty_change" },
        },
      },
    });
  });

  it("returns RUN_FROZEN as a terminal stale Review", async () => {
    const { response, request } = await reviewWithFailure(
      {
        ok: false,
        reason: "RUN_FROZEN",
        frozenFields: ["flagConfig.rollout"],
        currentRunId: "run_route_terminal",
        attemptedChange: "APPLY_APPROVED_FLAG_CONFIG:flag_route_terminal",
      },
      "idem_review_run_frozen",
    );

    const error = {
      code: "RUN_FROZEN",
      message:
        "running Run run_route_terminal owns this Flag Configuration field; end it to change this",
      details: {
        frozenFields: ["flagConfig.rollout"],
        currentRunId: "run_route_terminal",
        attemptedChange: "APPLY_APPROVED_FLAG_CONFIG:flag_route_terminal",
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    };
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(error);
    expect(request).toMatchObject({
      status: "stale",
      latestReview: {
        outcome: "stale",
        error: { code: error.code, details: error.details },
      },
    });
  });

  it("returns VARIANT_NOT_AVAILABLE as a retryable failed Review", async () => {
    const { response, request } = await reviewWithFailure(
      { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants: ["route-treatment"] },
      "idem_review_variant_not_available",
    );
    if (!request.latestReview) throw new Error("Review POST did not persist its failed Review");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "APPROVAL_APPLICATION_FAILED",
      message: "Approval Request application failed and was rolled back",
      details: {
        approvalRequestId: request.id,
        reviewId: request.latestReview.id,
        applicationError: {
          code: "VARIANT_NOT_AVAILABLE",
          details: {
            flagId: ids.flagId,
            environmentId: ids.environmentId,
            missingVariants: ["route-treatment"],
            recommendedAction: "ADD_VARIANT_TO_ENV",
          },
        },
        recommendedAction: "RETRY_REVIEW",
      },
    });
    expect(request).toMatchObject({
      status: "pending",
      latestReview: {
        outcome: "failed",
        error: {
          code: "VARIANT_NOT_AVAILABLE",
          details: {
            flagId: ids.flagId,
            environmentId: ids.environmentId,
            missingVariants: ["route-treatment"],
            recommendedAction: "ADD_VARIANT_TO_ENV",
          },
        },
      },
    });
  });
});

async function reviewWithFailure(
  failure: ApplyFailure,
  idempotencyKey: string,
): Promise<{ response: Response; request: ApprovalRequest }> {
  const approvalRequestId = await proposeA(h);
  const app = makeAuthedApp(h, refusingWriter(failure));
  const jwt = await token(h.signer);
  const response = await app.request(
    `/apps/${ids.appId}/approval-requests/${approvalRequestId}/reviews`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ action: "approve_and_apply", idempotency_key: idempotencyKey }),
    },
  );
  const read = await app.request(`/apps/${ids.appId}/approval-requests/${approvalRequestId}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(read.status).toBe(200);
  return { response, request: (await read.json()) as ApprovalRequest };
}

function refusingWriter(failure: ApplyFailure): ConfigStoreWriter {
  return {
    async applyApprovedFlagConfig(input) {
      expect(input).toMatchObject({
        appId: ids.appId,
        environmentId: ids.environmentId,
        flagId: ids.flagId,
      });
      return failure;
    },
  } as ConfigStoreWriter;
}
