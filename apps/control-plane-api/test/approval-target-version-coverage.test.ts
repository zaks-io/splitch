import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, ids, setProdPolicy } from "../src/config-store-harness-core";
import {
  clearFrozenRun,
  confirmPolicy,
  insertEnvironment,
  insertFlagConfig,
  patchVariant,
  readRequest,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * The Variant `target_version` must cover every Environment where the Variant is
 * effectively servable, recomputed at Review time — not just the Environments
 * that happened to be in `policy_contexts` when the request was proposed. Any
 * difference in that set (a new Environment, a newly servable one, a deleted
 * one, a Policy level change) has to invalidate the proposal, otherwise a
 * proposal approved against a lax set silently applies behind a stricter
 * Environment's Policy.
 *
 * These cases were originally written as exploits against that gap; they are
 * kept as regressions and now assert the gate holds.
 */

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await clearFrozenRun(h);
});

afterEach(async () => {
  await h.dispose();
});

async function proposeVariantValue(key: string, value: string): Promise<string> {
  const proposed = await patchVariant(h, "treatment", key, { value });
  expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");
  return proposed.approvalRequestId as string;
}

async function expectStale(requestId: string, idempotencyKey: string): Promise<void> {
  const applied = await reviewRequest(h, requestId, idempotencyKey);
  expect(applied.status).toBe(409);
  expect(((await applied.json()) as { code: string }).code).toBe("APPROVAL_REQUEST_STALE");
}

describe("the Variant target_version covers the servable-Environment vector", () => {
  it("a NEW Environment where the Variant is servable invalidates a pending proposal", async () => {
    const requestId = await proposeVariantValue("idem_c1", "escalated-c1");

    await insertEnvironment(h, "env_new_c1", confirmPolicy);
    await insertFlagConfig(h, "env_new_c1");

    const read = await readRequest(h, requestId);
    expect(read.body.status).toBe("stale");
    await expectStale(requestId, "idem_c1r");

    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.value).toBe(JSON.stringify("on"));
  });

  it("a flag_config appearing in a previously unservable Environment invalidates it too", async () => {
    // The Environment exists at proposal time but carries no flag_config, so the
    // Variant is not servable there and it is legitimately absent from the
    // frozen contexts. Adding the config makes it servable and must invalidate.
    await insertEnvironment(h, "env_late_c2", confirmPolicy);
    const requestId = await proposeVariantValue("idem_c2", "escalated-c2");
    const stored = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    const contexts = JSON.parse(stored?.policyContexts ?? "[]") as Array<{ environmentId: string }>;
    expect(contexts.some((c) => c.environmentId === "env_late_c2")).toBe(false);

    await insertFlagConfig(h, "env_late_c2");
    await expectStale(requestId, "idem_c2r");
  });

  it("a covered Environment's config change makes it stale", async () => {
    const requestId = await proposeVariantValue("idem_c3", "escalated-c3");
    await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
      enabled: true,
      updatedAt: "2026-07-02T13:00:00.000Z",
    });
    await expectStale(requestId, "idem_c3r");
  });

  it("an unchanged servable vector still applies", async () => {
    const requestId = await proposeVariantValue("idem_c3b", "approved-c3b");
    const applied = await reviewRequest(h, requestId, "idem_c3br");
    expect(applied.status).toBe(200);
    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.value).toBe(JSON.stringify("approved-c3b"));
  });
});
