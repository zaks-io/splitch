import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("starts independent snapshot reads in one D1 round-trip phase", async () => {
    const experimentReadStarted = deferred<void>();
    const releaseExperimentRead = deferred<void>();
    const originalExperimentRead = h.repo.experiments.findRunningExperimentForFlag.bind(
      h.repo.experiments,
    );
    vi.spyOn(h.repo.experiments, "findRunningExperimentForFlag").mockImplementation(
      async (...args) => {
        experimentReadStarted.resolve();
        await releaseExperimentRead.promise;
        return originalExperimentRead(...args);
      },
    );
    const getFlag = vi.spyOn(h.repo.flags, "getFlag");
    const getFlagConfig = vi.spyOn(h.repo.flags, "getFlagConfig");
    const listVariantsForFlags = vi.spyOn(h.repo.flags, "listVariantsForFlags");
    const listTargetingRules = vi.spyOn(h.repo.flags, "listTargetingRules");

    const snapshot = buildSnapshotFromD1(
      h.repo,
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    await experimentReadStarted.promise;

    expect(getFlag).toHaveBeenCalledOnce();
    expect(getFlagConfig).toHaveBeenCalledOnce();
    expect(listVariantsForFlags).toHaveBeenCalledOnce();
    expect(listTargetingRules).toHaveBeenCalledOnce();

    releaseExperimentRead.resolve();
    await expect(snapshot).resolves.toMatchObject({ flag: { id: ids.flagId } });
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
