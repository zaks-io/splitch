import assert from "node:assert/strict";
import test from "node:test";
import { assertStructuredAuthFailure } from "./dark-launch/cleanup.mjs";
import {
  createDarkLaunchFlag,
  deleteFlag,
  replaceTargetingRules,
  updateFlagConfig,
} from "./dark-launch/control-plane.mjs";
import { assertExposureHealth, summarizeExposureHealth } from "./dark-launch/hosted-results.mjs";
import { cleanupDeferredRuns, findOrphanedDarkLaunchApps } from "./dark-launch/hosted-cleanup.mjs";
import {
  assertVariant,
  DEFAULT_VARIANT,
  LAUNCH_VARIANT,
  PROPAGATION_WINDOW_MS,
  syntheticKeys,
  variantName,
} from "./dark-launch/journey.mjs";
import { buildSeedSql } from "./seed-shared-preview-smoke-sql.mjs";

test("syntheticKeys produces stable, lowercase App and Flag keys", () => {
  const keys = syntheticKeys("Run_ABC-123");
  assert.match(keys.appKey, /^dark-launch-app-/);
  assert.match(keys.flagKey, /^dark-launch-/);
  assert.match(keys.experimentKey, /^dark-launch-experiment-/);
  assert.equal(keys.appKey, keys.appKey.toLowerCase());
  assert.equal(keys.flagKey, keys.flagKey.toLowerCase());
});

test("shared-preview seed provides a live foreign Organization with a different owner", () => {
  const sql = buildSeedSql("2026-07-31T00:00:00.000Z");
  assert.match(sql, /org_shared_preview_isolation/);
  assert.match(sql, /app_shared_preview_isolation/);
  assert.match(sql, /user_shared_preview_isolation_owner/);
  assert.doesNotMatch(sql, /VALUES \('org_shared_preview_isolation', 'user_shared_preview_smoke',/);
});

test("hosted result evidence requires exactly one raw and deduped Exposure", () => {
  const result = {
    run_id: "run-1",
    stats: {
      health: {
        exposure_counts: { on: 1 },
        deduped_counts: { on: 1 },
        multiple_count: 0,
      },
    },
  };
  assert.doesNotThrow(() => assertExposureHealth(result, 1));
  assert.deepEqual(summarizeExposureHealth(result), {
    runId: "run-1",
    exposureCounts: { on: 1 },
    exposureTotal: 1,
    dedupedCounts: { on: 1 },
    dedupedTotal: 1,
    multipleCount: 0,
  });
  assert.throws(
    () =>
      assertExposureHealth(
        {
          ...result,
          stats: {
            health: {
              ...result.stats.health,
              exposure_counts: { on: 2 },
            },
          },
        },
        1,
      ),
    /expected 1 raw Exposures/,
  );
});

test("hosted cleanup rereads after the final deletion and derives reports", async () => {
  const cleanupOrder = [];
  const reports = await cleanupDeferredRuns([
    {
      runId: "run-1",
      cleanup: async () => {
        cleanupOrder.push("run-1");
        return { appDeleted: true, flagDeleted: true, credentialRevoked: true };
      },
    },
    {
      runId: "run-2",
      cleanup: async () => {
        cleanupOrder.push("run-2");
        return { appDeleted: true, flagDeleted: true, credentialRevoked: true };
      },
    },
  ]);
  assert.deepEqual(cleanupOrder, ["run-2", "run-1"]);
  assert.equal(
    reports.every((report) => report.appDeleted),
    true,
  );

  let reads = 0;
  const cleanScans = await findOrphanedDarkLaunchApps(
    { smokeOrgId: "org-smoke" },
    {
      callTool: async () => {
        reads += 1;
        return { items: [] };
      },
    },
    0,
  );
  assert.equal(reads, 2);
  assert.deepEqual(cleanScans, [[], []]);

  await assert.rejects(
    () =>
      findOrphanedDarkLaunchApps(
        { smokeOrgId: "org-smoke" },
        {
          callTool: async () =>
            reads++ % 2 === 0
              ? { items: [] }
              : { items: [{ id: "app-late", key: "dark-launch-app-late" }] },
        },
        0,
      ),
    /orphaned Apps/,
  );
});

test("variantName maps boolean values and explicit variantName", () => {
  assert.equal(variantName({ value: false, variantName: null }), DEFAULT_VARIANT);
  assert.equal(variantName({ value: true, variantName: null }), LAUNCH_VARIANT);
  assert.equal(variantName({ value: true, variantName: "on" }), "on");
});

test("assertVariant rejects ERROR resolutions", () => {
  assert.throws(
    () => assertVariant({ value: false, variantName: "off", reason: "ERROR" }, "off", "probe"),
    /failed loud/,
  );
});

test("propagation window matches the documented 60s KV lag", () => {
  assert.equal(PROPAGATION_WINDOW_MS, 60_000);
});

test("assertStructuredAuthFailure requires the expected errorCode", async () => {
  await assertStructuredAuthFailure(
    async () => ({ reason: "ERROR", errorCode: "FLAG_NOT_FOUND", value: false }),
    "FLAG_NOT_FOUND",
    "wrong-App",
  );

  await assert.rejects(
    () =>
      assertStructuredAuthFailure(
        async () => ({ reason: "ERROR", errorCode: "UNAUTHORIZED", value: false }),
        "FLAG_NOT_FOUND",
        "wrong-App",
      ),
    /expected errorCode FLAG_NOT_FOUND/,
  );

  await assert.rejects(
    () =>
      assertStructuredAuthFailure(
        async () => {
          throw new Error("network down");
        },
        "CREDENTIAL_REVOKED",
        "revoked",
      ),
    /but the call threw/,
  );

  await assert.rejects(
    () =>
      assertStructuredAuthFailure(
        async () => ({ reason: "DEFAULT", value: false }),
        "CREDENTIAL_REVOKED",
        "revoked",
      ),
    /expected reason ERROR/,
  );
});

test("dark-launch Flag mutations use current idempotency and deletion approval contracts", async () => {
  const requests = [];
  const deps = {
    accessToken: "test-access-token",
    controlPlaneBaseUrl: "https://control-plane.example.test",
    runId: "run-123",
    fetch: async (url, init) => {
      requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      if (init.method === "DELETE") {
        return Response.json(
          {
            code: "APPROVAL_REVIEW_REQUIRED",
            message: "Approval Request is pending Review",
            details: { approvalRequestId: "approval-123" },
          },
          { status: 409 },
        );
      }
      return Response.json(
        url.endsWith("/flags")
          ? {
              id: "flag-123",
              variants: [
                { id: "variant-on", name: LAUNCH_VARIANT, value: true, isDefault: false },
                { id: "variant-off", name: DEFAULT_VARIANT, value: false, isDefault: true },
              ],
            }
          : { status: "applied" },
      );
    },
  };

  await createDarkLaunchFlag(deps, "app-123", "flag-key");
  await updateFlagConfig(deps, "app-123", "env-123", "flag-123", { enabled: true });
  await replaceTargetingRules(deps, "app-123", "env-123", "flag-123", []);
  await deleteFlag(deps, "app-123", "flag-123");

  assert.equal(requests[0].body.idempotency_key, "dark-launch-flag-create-run-123");
  assert.equal(requests[0].init.headers["idempotency-key"], "dark-launch-flag-create-run-123");
  assert.equal(requests[1].body.idempotency_key, "dark-launch-flag-config-enable-run-123");
  assert.equal(
    requests[1].init.headers["idempotency-key"],
    "dark-launch-flag-config-enable-run-123",
  );
  assert.equal(requests[2].body.idempotency_key, "dark-launch-targeting-rules-run-123");
  assert.equal(requests[2].init.headers["idempotency-key"], "dark-launch-targeting-rules-run-123");
  assert.equal(requests[3].init.headers["idempotency-key"], "dark-launch-flag-delete-run-123");
  assert.equal(
    requests[4].url,
    "https://control-plane.example.test/apps/app-123/approval-requests/approval-123/reviews",
  );
  assert.deepEqual(requests[4].body, {
    action: "approve_and_apply",
    idempotency_key: "dark-launch-flag-delete-review-run-123",
  });
  assert.equal(
    requests[4].init.headers["idempotency-key"],
    "dark-launch-flag-delete-review-run-123",
  );
});
