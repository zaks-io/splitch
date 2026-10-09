import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSeededExperiment } from "../src/config-store-fixture-data";
import type { Harness } from "../src/config-store-harness-core";
import { ids } from "../src/config-store-harness-core";
import {
  buildEvaluationSnapshotFromD1,
  buildSnapshotFromD1,
} from "../src/config-store-snapshot-build";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

describe("config store evaluation snapshot read", () => {
  it("builds the same snapshot by Flag key as by Flag id", async () => {
    await startSeededExperiment(h.d1);
    const scope = envScope(ids.appId, ids.environmentId);

    const byKey = await buildEvaluationSnapshotFromD1(h.repo, scope, ids.flagKey);

    expect(byKey).toMatchObject({ run: { id: ids.liveRunId } });
    expect(byKey).toEqual(await buildSnapshotFromD1(h.repo, scope, ids.flagId));
  });

  it("returns null for a key the App does not hold", async () => {
    await expect(
      buildEvaluationSnapshotFromD1(
        h.repo,
        envScope(ids.appId, ids.environmentId),
        "no-such-flag-key",
      ),
    ).resolves.toBeNull();
  });

  it("re-reads by id when the key moved to another Flag mid-read", async () => {
    const scope = envScope(ids.appId, ids.environmentId);
    vi.spyOn(h.repo.flagEvaluation, "readFlagSnapshotInputsByKey").mockResolvedValue("moved");
    const getFlagByKey = vi.spyOn(h.repo.flags, "getFlagByKey");

    const snapshot = await buildEvaluationSnapshotFromD1(h.repo, scope, ids.flagKey);

    expect(getFlagByKey).toHaveBeenCalledOnce();
    expect(snapshot).toEqual(await buildSnapshotFromD1(h.repo, scope, ids.flagId));
  });
});
