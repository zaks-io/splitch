import assert from "node:assert/strict";
import test from "node:test";
import { cleanupDarkLaunch } from "./dark-launch/cleanup.mjs";
import { throwPrimaryWithCleanup } from "./dark-launch/cleanup-failures.mjs";
import { cleanupDeferredRuns, findOrphanedDarkLaunchApps } from "./dark-launch/hosted-cleanup.mjs";
import { assertExposureHealth, summarizeExposureHealth } from "./dark-launch/hosted-results.mjs";

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
  assert.throws(
    () =>
      assertExposureHealth(
        {
          ...result,
          stats: { health: { ...result.stats.health, multiple_count: 1 } },
        },
        1,
      ),
    /multiple_count=0, got 1/,
  );
  assert.throws(
    () =>
      assertExposureHealth(
        {
          ...result,
          stats: {
            health: {
              ...result.stats.health,
              exposure_counts: { on: 1, __multiple__: 0 },
            },
          },
        },
        1,
      ),
    /__multiple__/,
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

  let lateReads = 0;
  const lateScans = await findOrphanedDarkLaunchApps(
    { smokeOrgId: "org-smoke" },
    {
      callTool: async () =>
        lateReads++ === 0
          ? { items: [] }
          : { items: [{ id: "app-late", key: "dark-launch-app-late" }] },
    },
    0,
  );
  assert.equal(lateReads, 2);
  assert.deepEqual(lateScans, [[], [{ id: "app-late", key: "dark-launch-app-late" }]]);
});

test("cleanup continues after failures and reports every failed step", async () => {
  const calls = [];
  const deps = {
    orgId: "org-smoke",
    runId: "proof-run",
    cleanupStabilityWindowMs: 0,
    callTool: async (name) => {
      calls.push(name);
      if (name === "runs_end") throw new Error("run end unavailable");
      if (name === "experiments_delete") throw new Error("experiment delete unavailable");
      if (name === "apps_delete") return {};
      if (name === "apps_list") return { items: [] };
      throw new Error(`unexpected tool ${name}`);
    },
    callToolResult: async (name) => {
      calls.push(name);
      if (name === "flags_delete") throw new Error("flag delete unavailable");
      throw new Error(`unexpected result tool ${name}`);
    },
    assertCredentialRevoked: async () => {
      calls.push("assertCredentialRevoked");
      throw new Error("credential remained active");
    },
  };
  const resources = {
    appId: "app-1",
    environmentId: "env-1",
    flagId: "flag-1",
    experimentId: "experiment-1",
    runId: "run-1",
    ownsApp: true,
    clientKeyMaterial: "client-key",
    transientAppKeys: [],
  };

  await assert.rejects(
    () => cleanupDarkLaunch(deps, resources, { appKey: "app-key", flagKey: "flag-key" }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 4);
      assert.match(error.message, /cleanup steps failed/);
      return true;
    },
  );
  assert.deepEqual(calls, [
    "runs_end",
    "experiments_delete",
    "flags_delete",
    "apps_delete",
    "assertCredentialRevoked",
    "apps_list",
    "apps_list",
  ]);
});

test("journey failure remains primary when cleanup also fails", () => {
  const journeyFailure = new Error("journey failed");
  const cleanupFailure = new Error("cleanup failed");
  assert.throws(
    () => throwPrimaryWithCleanup(journeyFailure, [cleanupFailure], "journey and cleanup failed"),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors[0], journeyFailure);
      assert.equal(error.errors[1], cleanupFailure);
      assert.equal(error.cause, journeyFailure);
      return true;
    },
  );
});
