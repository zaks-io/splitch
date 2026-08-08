import { appScope } from "@splitch/db";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigStoreWriter } from "../src/config-store";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import {
  type Harness,
  ids,
  makeAuthedApp,
  NOW,
  setProdPolicy,
  token,
} from "../src/config-store-harness-core";
import { clearFrozenRun, confirmPolicy, proposeA } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * `APPROVAL_APPLICATION_FAILED` carries a claim about the operator's own data,
 * so the message has to name which of the three things happened to the target.
 * `approval-review-apply-failure-route.test.ts` pins the rolled-back wording on
 * the Flag Configuration pre-checks; these two pin the other two states against
 * the paths that actually produce them.
 */
let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("Approval application failure names what happened to the target", () => {
  it("reports an unknown target state when the application throws", async () => {
    await setProdPolicy(h, confirmPolicy);
    await clearFrozenRun(h);
    const approvalRequestId = await proposeA(h);

    const response = await review(
      makeAuthedApp(h, throwingWriter()),
      approvalRequestId,
      "idem_review_thrown",
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "APPROVAL_APPLICATION_FAILED",
      message:
        "Approval Request application failed and the target state is unknown; re-read the Approval Request",
      details: {
        approvalRequestId,
        applicationError: { code: "INTERNAL_SERVER_ERROR", details: {} },
        recommendedAction: "RETRY_REVIEW",
      },
    });
  });

  it("reports the target as changed when Segment republication fails after the write", async () => {
    const approvalRequestId = await proposeSegmentConditions();

    const response = await review(
      makeAuthedApp(h, refusingResyncWriter()),
      approvalRequestId,
      "idem_review_republish",
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "APPROVAL_APPLICATION_FAILED",
      message: "Approval Request application changed the target, but a later step failed",
      details: {
        approvalRequestId,
        applicationError: { code: "INTERNAL_SERVER_ERROR" },
        recommendedAction: "RETRY_REVIEW",
      },
    });
    // The message is only true if the Segment mutation really is durable: the
    // write lands before republication runs, so the row must already hold the
    // approved Conditions even though the Review failed.
    expect(await h.repo.flags.getSegment(appScope(ids.appId), "segment_paid")).toMatchObject({
      conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "enterprise" }]),
    });
  });
});

/**
 * A gated Segment Conditions change whose dependent Flag Configuration lives in
 * the `confirm` Environment, left pending Review.
 */
async function proposeSegmentConditions(): Promise<string> {
  await narrowSeededAvailability(h.d1);
  await h.repo.flags.segments.insert(appScope(ids.appId), {
    id: "segment_paid",
    appId: ids.appId,
    name: "Paid plan",
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "paid" }]),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const rules = await send(
    h.app,
    "PUT",
    `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/targeting-rules`,
    "segment_rules",
    {
      targetingRules: [
        {
          id: "rule_segment_paid",
          flagId: ids.flagId,
          priority: 0,
          conditions: [],
          segmentId: "segment_paid",
          variantId: ids.treatmentVariantId,
          percentageRollout: null,
        },
      ],
    },
  );
  expect(rules.status).toBe(200);
  await setProdPolicy(h, {
    variantAvailability: "allow",
    targetingRolloutValue: "confirm",
    enabledState: "allow",
    startExperimentRun: "allow",
  });

  const proposed = await send(
    h.app,
    "PATCH",
    `/apps/${ids.appId}/segments/segment_paid`,
    "segment_conditions",
    { conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }] },
  );
  expect(proposed.status).toBe(409);
  const body = (await proposed.json()) as { code: string; details: { approvalRequestId: string } };
  expect(body.code).toBe("APPROVAL_REVIEW_REQUIRED");
  return body.details.approvalRequestId;
}

function review(app: Hono, approvalRequestId: string, idempotencyKey: string) {
  return send(
    app,
    "POST",
    `/apps/${ids.appId}/approval-requests/${approvalRequestId}/reviews`,
    idempotencyKey,
    { action: "approve_and_apply" },
  );
}

async function send(
  app: Hono,
  method: string,
  path: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
) {
  const jwt = await token(h.signer);
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ idempotency_key: idempotencyKey, ...body }),
  });
}

/** An exception can land on either side of the target write. */
function throwingWriter(): ConfigStoreWriter {
  return {
    async applyApprovedFlagConfig() {
      throw new Error("config store exploded mid-apply");
    },
  } as unknown as ConfigStoreWriter;
}

/** The Segment write succeeds; only the dependent republication fan-out fails. */
function refusingResyncWriter(): ConfigStoreWriter {
  return {
    async resyncFlagConfig() {
      return { ok: false as const, reason: "SEGMENT_NOT_FOUND" as const, missingSegmentIds: [] };
    },
  } as unknown as ConfigStoreWriter;
}
