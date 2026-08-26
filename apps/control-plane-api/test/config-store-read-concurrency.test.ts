import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSeededExperiment } from "../src/config-store-fixture-data";
import type { Harness } from "../src/config-store-harness-core";
import { ids } from "../src/config-store-harness-core";
import { buildSnapshotFromD1 } from "../src/config-store-shared";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("config store snapshot reads", () => {
  it("starts exactly five independent reads in the first D1 round-trip phase", async () => {
    const allReadsStarted = deferred<void>();
    const releaseReads = deferred<void>();
    let activeReads = 0;
    let peakReads = 0;
    const gatedRead = async <T>(read: () => Promise<T>): Promise<T> => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      if (activeReads === 5) allReadsStarted.resolve();
      await releaseReads.promise;
      activeReads -= 1;
      return read();
    };
    const originalExperimentRead = h.repo.experiments.findRunningExperimentForFlag.bind(
      h.repo.experiments,
    );
    vi.spyOn(h.repo.experiments, "findRunningExperimentForFlag").mockImplementation((...args) =>
      gatedRead(() => originalExperimentRead(...args)),
    );
    const originalGetFlag = h.repo.flags.getFlag.bind(h.repo.flags);
    vi.spyOn(h.repo.flags, "getFlag").mockImplementation((...args) =>
      gatedRead(() => originalGetFlag(...args)),
    );
    const originalGetFlagConfig = h.repo.flags.getFlagConfig.bind(h.repo.flags);
    vi.spyOn(h.repo.flags, "getFlagConfig").mockImplementation((...args) =>
      gatedRead(() => originalGetFlagConfig(...args)),
    );
    const originalListVariants = h.repo.flags.listVariantsForFlags.bind(h.repo.flags);
    vi.spyOn(h.repo.flags, "listVariantsForFlags").mockImplementation((...args) =>
      gatedRead(() => originalListVariants(...args)),
    );
    const originalListRules = h.repo.flags.listTargetingRules.bind(h.repo.flags);
    vi.spyOn(h.repo.flags, "listTargetingRules").mockImplementation((...args) =>
      gatedRead(() => originalListRules(...args)),
    );

    const snapshot = buildSnapshotFromD1(
      h.repo,
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    await allReadsStarted.promise;

    expect(peakReads).toBe(5);

    releaseReads.resolve();
    await expect(snapshot).resolves.toMatchObject({ flag: { id: ids.flagId } });
  });

  it("resolves targeting rules and the live Run concurrently", async () => {
    await startSeededExperiment(h.d1);
    const segmentReadStarted = deferred<void>();
    const releaseSegmentRead = deferred<void>();
    const originalSegmentRead = h.repo.flags.listSegmentsByIds.bind(h.repo.flags);
    vi.spyOn(h.repo.flags, "listSegmentsByIds").mockImplementation(async (...args) => {
      segmentReadStarted.resolve();
      await releaseSegmentRead.promise;
      return originalSegmentRead(...args);
    });
    const getRun = vi.spyOn(h.repo.experiments, "getRun");

    const snapshot = buildSnapshotFromD1(
      h.repo,
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    await segmentReadStarted.promise;

    expect(getRun).toHaveBeenCalledWith(envScope(ids.appId, ids.environmentId), ids.liveRunId);

    releaseSegmentRead.resolve();
    await expect(snapshot).resolves.toMatchObject({ run: { id: ids.liveRunId } });
  });
});

function deferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) throw new Error("deferred promise was not initialized");
  return { promise, resolve: resolvePromise };
}
