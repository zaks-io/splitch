import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  patchFlagConfig,
  setProdPolicy,
  token,
} from "../src/config-store-harness-core";
import {
  invalidateEnvironmentPolicyGateCache,
  peekEnvironmentPolicyGateCacheForTest,
  seedStaleEnvironmentPolicyGateCacheForTest,
} from "../src/environment-policy-gate-cache";
import { readEnvironmentPolicy } from "../src/flag-config-policy";
import { allowPolicy, clearFrozenRun, confirmPolicy } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * SPL-292: after an Environment Policy write commits, the next gated mutation
 * in a fresh request context must evaluate the new Policy. A seeded isolate
 * cache must not let a confirm-gated change type apply with approvalRequest:null.
 */
let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await clearFrozenRun(h);
  // Start from allow so the HTTP tighten below is a real transition.
  await setProdPolicy(h, allowPolicy);
  invalidateEnvironmentPolicyGateCache(ids.appId, ids.environmentId);
});

afterEach(async () => {
  invalidateEnvironmentPolicyGateCache(ids.appId, ids.environmentId);
  await h.dispose();
});

async function patchEnvironmentPolicy(
  policy: typeof confirmPolicy | typeof allowPolicy,
): Promise<Response> {
  const jwt = await token(h.signer);
  return h.app.request(`/apps/${ids.appId}/envs/${ids.environmentId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ policy }),
  });
}

describe("Environment Policy gate read-your-writes (SPL-292)", () => {
  it("refuses a gated write in the next request after Policy is tightened to confirm", async () => {
    const tightened = await patchEnvironmentPolicy(confirmPolicy);
    expect(tightened.status).toBe(200);
    expect(await tightened.json()).toMatchObject({ policy: confirmPolicy });

    // Fresh HTTP request context — not the same handler invocation as the write.
    const gated = await patchFlagConfig(h, { enabled: true });
    expect(gated.status).toBe(409);
    expect(await gated.json()).toMatchObject({
      code: "APPROVAL_REVIEW_REQUIRED",
      details: {
        approvalRequestId: expect.stringMatching(/^apr_/),
        policyContexts: [
          expect.objectContaining({
            environmentId: ids.environmentId,
            changeTypes: ["enabled_state"],
            level: "confirm",
          }),
        ],
      },
    });
    expect(await h.repo.approvals.countRequests(appScope(ids.appId), {})).toBe(1);
  });

  it("ignores a seeded stale allow cache and still gates after confirm is durable", async () => {
    await setProdPolicy(h, confirmPolicy);
    // Simulate the stale path: isolate still holds the pre-tighten Policy.
    seedStaleEnvironmentPolicyGateCacheForTest(ids.appId, ids.environmentId, allowPolicy);
    expect(peekEnvironmentPolicyGateCacheForTest(ids.appId, ids.environmentId)).toEqual(
      allowPolicy,
    );

    const fromGate = await readEnvironmentPolicy(h.repo, ids.appId, ids.environmentId);
    expect(fromGate).toEqual(confirmPolicy);
    // Seeded entry must be gone after the authoritative read.
    expect(peekEnvironmentPolicyGateCacheForTest(ids.appId, ids.environmentId)).toBeUndefined();

    const gated = await patchFlagConfig(h, { availableVariantNames: ["control"] });
    expect(gated.status).toBe(409);
    expect(await gated.json()).toMatchObject({
      code: "APPROVAL_REVIEW_REQUIRED",
      details: {
        policyContexts: [
          expect.objectContaining({
            changeTypes: ["variant_availability"],
            level: "confirm",
          }),
        ],
      },
    });
  });

  it("invalidates the isolate cache when Policy is written through the Environment API", async () => {
    seedStaleEnvironmentPolicyGateCacheForTest(ids.appId, ids.environmentId, allowPolicy);
    const tightened = await patchEnvironmentPolicy(confirmPolicy);
    expect(tightened.status).toBe(200);
    expect(peekEnvironmentPolicyGateCacheForTest(ids.appId, ids.environmentId)).toBeUndefined();
  });

  it("loosening to allow never 500s or double-creates Approval Requests", async () => {
    await setProdPolicy(h, confirmPolicy);
    const blocked = await patchFlagConfig(h, { enabled: true });
    expect(blocked.status).toBe(409);
    expect(await h.repo.approvals.countRequests(appScope(ids.appId), {})).toBe(1);

    const loosened = await patchEnvironmentPolicy(allowPolicy);
    expect(loosened.status).toBe(200);

    const jwt = await token(h.signer);
    const second = await h.app.request(
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "idempotency-key": "idem_policy_loosen",
        },
        body: JSON.stringify({ idempotency_key: "idem_policy_loosen", enabled: true }),
      },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      approvalRequest: null,
      config: { enabled: true },
    });
    // Still exactly one Approval Request from the confirm-era attempt.
    expect(await h.repo.approvals.countRequests(appScope(ids.appId), {})).toBe(1);
  });

  it("keeps kill-switch-off ungated under all-confirm (not a stale-Policy bypass)", async () => {
    await setProdPolicy(h, confirmPolicy);
    const enable = await patchFlagConfig(h, {
      enabled: true,
      review: { action: "approve_and_apply" },
    });
    expect(enable.status).toBe(200);

    const disable = await patchFlagConfig(h, { enabled: false });
    expect(disable.status).toBe(200);
    expect(await disable.json()).toMatchObject({
      approvalRequest: null,
      config: { enabled: false },
    });
  });
});
