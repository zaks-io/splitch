import assert from "node:assert/strict";
import test from "node:test";

import {
  APP,
  DEV,
  DEV_KEY,
  fakeControlPlane,
  OTHER,
  PROD,
  PROD_KEY,
} from "./safe-delivery/fake-control-plane.mjs";
import { runSafeDeliveryJourney } from "./safe-delivery/journey.mjs";

function journeyDeps(overrides = {}) {
  return {
    fetch: fakeControlPlane(overrides.server),
    accessToken: "token",
    runId: "run-1-r1",
    controlPlaneBaseUrl: "https://cp.example.test",
    evaluationBaseUrl: "https://edge.example.test",
    appId: APP,
    devEnvironmentId: DEV,
    prodEnvironmentId: PROD,
    otherAppEnvironmentId: OTHER,
    devClientKey: DEV_KEY,
    prodClientKey: PROD_KEY,
    stableFlagKey: "shared-preview-smoke",
    propagationWindowMs: 50,
    sleep: async () => {},
    ...overrides.deps,
  };
}

test("the safe-delivery journey completes every proof in order", async () => {
  const result = await runSafeDeliveryJourney(journeyDeps());

  assert.deepEqual(result.steps, [
    "cohort_segment_defined",
    "flags_create",
    "dev_tune_ungated",
    "dev_targeting_keys_verified",
    "prod_baseline_captured",
    "dangling_variant_rejected",
    "unauthorized_promotion_rejected",
    "stale_review_rejected",
    "promotion_diff_matches_preview_and_applied",
    "promotion_applied_selected_field_groups_only",
    "prod_resolution_unchanged_before_enable",
    "enabled_promotion_confirmed",
    "prod_resolution_changed_after_propagation",
    "kill_switch_off_ungated",
  ]);

  assert.deepEqual(result.evidence.danglingVariant.missingVariants, ["holdout"]);
  assert.equal(result.evidence.unauthorizedPromotion.crossAppSource, "VALIDATION_ERROR");
  assert.equal(result.evidence.unauthorizedPromotion.sameEnvironmentSource, "VALIDATION_ERROR");
  assert.equal(result.evidence.staleReview.code, "APPROVAL_REQUEST_STALE");
  assert.deepEqual(result.evidence.selectedFieldGroups, ["availability", "targeting"]);
  assert.equal(result.evidence.killSwitch.ungated, true);
  assert.ok(result.evidence.killSwitch.versionAfter > result.evidence.killSwitch.versionBefore);
  assert.equal(result.evidence.cleanup.orphanedFlags, false);
  assert.equal(result.evidence.cleanup.stableFlagPreserved, true);
});

test("the journey fails loud if kill-switch-off is gated by an Approval Request", async () => {
  await assert.rejects(
    runSafeDeliveryJourney(journeyDeps({ server: { killSwitchApproval: { id: "ar-x" } } })),
    /kill-switch-off minted an Approval Request/,
  );
});

/**
 * D1-D6. The in-memory double is internally consistent, so every diff-equality
 * assertion passes vacuously unless the server is made to lie. Each case
 * corrupts exactly one leg of preview -> persisted -> applied and proves the
 * journey rejects it. Without these, neutering the assertions to
 * self-comparisons leaves the suite green.
 */
const diffCorruptions = [
  {
    name: "D1 promote diff.before disagrees with the captured baseline",
    server: { mutatePromoteResponse: (body) => void (body.diff.before.enabled = true) },
    expected: /promote diff\.before/,
  },
  {
    name: "D2 promote diff.after disagrees with the applied config",
    server: {
      mutatePromoteResponse: (body) => void body.diff.after.availableVariantNames.push("ghost"),
    },
    expected: /promote diff\.after/,
  },
  {
    name: "D3 promote response config disagrees with the applied config",
    server: { mutatePromoteResponse: (body) => void (body.config.rollout = { percentage: 99 }) },
    expected: /promote response config/,
  },
  {
    name: "D4 the persisted Approval Request is not applied",
    server: { mutateApprovalResponse: (body) => void (body.status = "pending") },
    expected: /Approval Request was not applied/,
  },
  {
    name: "D5 persisted diff.current disagrees with the baseline",
    server: { mutateApprovalResponse: (body) => void (body.diff.current.enabled = true) },
    expected: /persisted diff\.current/,
  },
  {
    name: "D6 persisted diff.proposed disagrees with the applied config",
    server: {
      mutateApprovalResponse: (body) => void body.diff.proposed.availableVariantNames.push("ghost"),
    },
    expected: /persisted diff\.proposed/,
  },
];

for (const corruption of diffCorruptions) {
  test(`the journey rejects when ${corruption.name}`, async () => {
    await assert.rejects(
      runSafeDeliveryJourney(journeyDeps({ server: corruption.server })),
      corruption.expected,
    );
  });
}

test("the journey rejects an unreviewable persisted diff (empty or unsorted entries)", async () => {
  await assert.rejects(
    runSafeDeliveryJourney(
      journeyDeps({ server: { mutateApprovalResponse: (body) => void (body.diff.entries = []) } }),
    ),
    /persisted diff\.entries was empty/,
  );

  await assert.rejects(
    runSafeDeliveryJourney(
      journeyDeps({
        server: {
          mutateApprovalResponse: (body) => void body.diff.entries.reverse(),
        },
      }),
    ),
    /diff\.entries paths are not sorted/,
  );
});

/**
 * S1. The stale-Review leg previously asserted only the error code, so a Worker
 * that refused AND half-applied the stale proposal stayed green.
 */
test("the journey rejects a stale Review refusal that still mutated the target", async () => {
  await assert.rejects(
    runSafeDeliveryJourney(journeyDeps({ server: { applyOnStaleRefusal: true } })),
    /stale Approval Request Review: refused write/,
  );
});

test("cleanup cannot prove Flag absence from a truncated flags_list page", async () => {
  await assert.rejects(
    runSafeDeliveryJourney(journeyDeps({ server: { flagsListTruncated: true } })),
    /flags_list truncated/,
  );
});

// --- The double's own fidelity. A double that diverges from the Worker on a
// path a proof depends on lets that proof pass for the wrong reason.

function fakeServer() {
  const fetchImpl = fakeControlPlane();
  const call = async (method, path, body) => {
    const response = await fetchImpl(`https://cp.example.test${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {},
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    call,
    async createFlag() {
      const created = await call("POST", "/apps/app-1/flags", {
        key: "safe-delivery-fidelity",
        variants: [
          { name: "control", isDefault: true },
          { name: "beta", isDefault: false },
        ],
      });
      return created.body;
    },
  };
}

test("the double confirm-gates a prod targeting-rule write and applies it in dev", async () => {
  const server = fakeServer();
  const flag = await server.createFlag();
  const rules = { targetingRules: [{ id: "r1", priority: 0, conditions: [], variantId: null }] };

  const prod = await server.call("PUT", `/apps/a/envs/${PROD}/flags/${flag.id}/targeting-rules`, {
    ...rules,
  });
  assert.equal(prod.status, 409);
  assert.equal(prod.body.code, "APPROVAL_REVIEW_REQUIRED");

  const dev = await server.call("PUT", `/apps/a/envs/${DEV}/flags/${flag.id}/targeting-rules`, {
    ...rules,
  });
  assert.equal(dev.status, 200);
  assert.equal(dev.body.config.targetingRules.length, 1);

  const missing = await server.call("PUT", `/apps/a/envs/${DEV}/flags/nope/targeting-rules`, rules);
  assert.equal(missing.body.code, "FLAG_NOT_FOUND");
});

test("the double declines a Review whose action is not approve_and_apply", async () => {
  const server = fakeServer();
  const flag = await server.createFlag();
  await server.call("PATCH", `/apps/a/envs/${DEV}/flags/${flag.id}/config`, { enabled: true });

  const gated = await server.call("POST", `/apps/a/envs/${PROD}/flags/${flag.id}/promote`, {
    fromEnvironmentId: DEV,
    select: { enabled: true },
  });
  assert.equal(gated.body.code, "APPROVAL_REVIEW_REQUIRED");
  const approvalId = gated.body.details.approvalRequestId;

  const declined = await server.call("POST", `/apps/a/approval-requests/${approvalId}/reviews`, {
    action: "reject",
  });
  assert.equal(declined.body.status, "declined");

  const after = await server.call("GET", `/apps/a/envs/${PROD}/flags/${flag.id}/config`);
  assert.equal(after.body.enabled, false, "a rejected Review still applied the promotion");
  assert.equal(after.body.version, 1, "a rejected Review still bumped the target version");

  const again = await server.call("POST", `/apps/a/approval-requests/${approvalId}/reviews`, {
    action: "approve_and_apply",
  });
  assert.equal(again.body.code, "APPROVAL_REQUEST_NOT_PENDING");
});

test("transient Flags are deleted even when a proof fails", async () => {
  const deps = journeyDeps({ deps: { otherAppEnvironmentId: PROD } });
  await assert.rejects(runSafeDeliveryJourney(deps));
  const remaining = await (await deps.fetch("https://cp.example.test/apps/app-1/flags", {})).json();
  assert.deepEqual(
    remaining.items.filter((flag) => flag.key.startsWith("safe-delivery-")),
    [],
    "a failed run left transient Flags behind",
  );
});
