import { describe, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import { createLocalD1 } from "./test-d1-pool";
import { seedTwoTenants } from "./test-seed";

describe("run_srm_alarms", () => {
  it("deletes alarm rows with the Run on archive purge", async () => {
    const local = await createLocalD1();
    try {
      const seed = await seedTwoTenants(local.d1);
      const repo = createRepository(local.d1);
      const scope = envScope(seed.a.appId, seed.a.environmentId);
      const runId = seed.a.runId;

      await repo.runSrmAlarms.insertIgnore(scope, {
        runId,
        srmKind: "exposure",
        firstCrossedAt: "2026-07-02T00:00:00.000Z",
        watermark: "2026-07-02T00:00:00.000Z",
        pValue: 0.0009455653996124124,
        analysisVersion: "analysis-v2",
      });
      expect(await repo.runSrmAlarms.listForRun(scope, runId)).toHaveLength(1);

      await local.d1
        .prepare(`UPDATE experiments SET status = 'archived' WHERE id = ?`)
        .bind(seed.a.experimentId)
        .run();
      await repo.experiments.purgeArchivedExperimentsInEnvironment(scope);

      expect(await repo.runSrmAlarms.listForRun(scope, runId)).toEqual([]);
      const leftover = await local.d1
        .prepare(`SELECT COUNT(*) AS n FROM run_srm_alarms WHERE run_id = ?`)
        .bind(runId)
        .first<{ n: number }>();
      expect(leftover?.n).toBe(0);
    } finally {
      await local.dispose();
    }
  });

  it("INSERT OR IGNORE keeps the first crossing", async () => {
    const local = await createLocalD1();
    try {
      const seed = await seedTwoTenants(local.d1);
      const repo = createRepository(local.d1);
      const scope = envScope(seed.a.appId, seed.a.environmentId);

      await repo.runSrmAlarms.insertIgnore(scope, {
        runId: seed.a.runId,
        srmKind: "exposure",
        firstCrossedAt: "2026-07-02T00:00:00.000Z",
        watermark: "2026-07-02T00:00:00.000Z",
        pValue: 0.0009455653996124124,
        analysisVersion: "analysis-v2",
      });
      await repo.runSrmAlarms.insertIgnore(scope, {
        runId: seed.a.runId,
        srmKind: "exposure",
        firstCrossedAt: "2026-07-03T00:00:00.000Z",
        watermark: "2026-07-03T00:00:00.000Z",
        pValue: 0.0012344881606050938,
        analysisVersion: "analysis-v2",
      });

      const rows = await repo.runSrmAlarms.listForRun(scope, seed.a.runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        firstCrossedAt: "2026-07-02T00:00:00.000Z",
        pValue: 0.0009455653996124124,
      });
    } finally {
      await local.dispose();
    }
  });
});
