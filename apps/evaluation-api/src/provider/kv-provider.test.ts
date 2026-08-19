import type { DeltaNudge, FlagConfigKV } from "@splitch/contracts";
import { experimentConfigKey, flagConfigKey } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeKv } from "./fake-kv";
import { experimentConfigKV, flagConfigKV, runConfigKV } from "./fixtures";
import { KvProvider } from "./kv-provider";

describe("KvProvider.getFlag", () => {
  it("resolves a FlagConfig with experimentId read in the SAME call — no second KV get", async () => {
    const kv = new FakeKv().put(
      flagConfigKey("app-A", "env-1", "checkout-banner"),
      flagConfigKV({ experimentId: "exp-7" }),
    );
    const provider = new KvProvider(kv);

    const flag = await provider.getFlag("app-A", "env-1", "checkout-banner");

    expect(flag.experimentId).toBe("exp-7");
    expect(flag.defaultVariant).toBe("control");
    // ONE read total, and ZERO experiment-key reads: the controlling Experiment
    // pointer rode on the flag blob, never a second lookup.
    expect(kv.getCalls).toHaveLength(1);
    expect(kv.getCallsMatching(":experiment:")).toBe(0);
    expect(kv.getCallsMatching(":run:")).toBe(0);
  });

  it("isolates tenants: getFlag for App A never returns App B config (app-scoped key)", async () => {
    const kv = new FakeKv()
      .put(flagConfigKey("app-A", "env-1", "f"), flagConfigKV({ key: "f", id: "a-flag" }))
      .put(flagConfigKey("app-B", "env-1", "f"), flagConfigKV({ key: "f", id: "b-flag" }));
    const provider = new KvProvider(kv);

    const flagA = await provider.getFlag("app-A", "env-1", "f");

    expect(flagA.appId).toBe("app-A");
    // The only key read is App A's; App B's key was never touched.
    expect(kv.getCalls).toEqual([flagConfigKey("app-A", "env-1", "f")]);
    expect(kv.getCallsMatching("app-B")).toBe(0);
  });

  it("serves a second read from cache (no extra KV get)", async () => {
    const kv = new FakeKv().put(flagConfigKey("app-A", "env-1", "f"), flagConfigKV({ key: "f" }));
    const provider = new KvProvider(kv);

    await provider.getFlag("app-A", "env-1", "f");
    await provider.getFlag("app-A", "env-1", "f");

    expect(kv.getCalls).toHaveLength(1);
  });

  it("re-fetches after a DeltaNudge invalidates the App's cache", async () => {
    const kv = new FakeKv().put(flagConfigKey("app-A", "env-1", "f"), flagConfigKV({ key: "f" }));
    let currentVersion = 1;
    const provider = new KvProvider(kv, {
      configUpdates: updates(async () => snapshot(flagConfigKV({ key: "f" }), currentVersion)),
    });
    const nudge: DeltaNudge = {
      type: "config.changed",
      entity: "flag",
      id: "flag-id-1",
      version: 3,
    };

    await provider.getFlag("app-A", "env-1", "f");
    currentVersion = 3;
    provider.invalidate("app-A", "env-1", nudge);
    kv.put(flagConfigKey("app-A", "env-1", "f"), flagConfigKV({ key: "f" }));
    await provider.getFlag("app-A", "env-1", "f");

    expect(kv.getCalls).toHaveLength(2);
  });

  it("checks authoritative config on cold start before serving or caching", async () => {
    const kv = new FakeKv().put(
      flagConfigKey("app-A", "env-1", "f"),
      flagConfigKV({ key: "f", enabled: false }),
    );
    const readCurrentFlagConfig = vi.fn(async () =>
      snapshot(flagConfigKV({ key: "f", enabled: true }), 2),
    );
    const provider = new KvProvider(kv, {
      configUpdates: updates(readCurrentFlagConfig),
    });

    await expect(provider.getFlag("app-A", "env-1", "f")).resolves.toMatchObject({
      enabled: true,
    });
    expect(readCurrentFlagConfig).toHaveBeenCalledWith("app-A", "env-1", "f");
  });

  it("recovers a cold-start KV miss from the authoritative snapshot", async () => {
    const provider = new KvProvider(new FakeKv(), {
      configUpdates: updates(async () => snapshot(flagConfigKV({ key: "f" }), 2)),
    });

    await expect(provider.getFlag("app-A", "env-1", "f")).resolves.toMatchObject({
      flagKey: "f",
    });
  });

  it("recovers a malformed KV blob from the authoritative snapshot", async () => {
    const key = flagConfigKey("app-A", "env-1", "f");
    const kv = new FakeKv().putRaw(key, "{malformed");
    const provider = new KvProvider(kv, {
      configUpdates: updates(async () => snapshot(flagConfigKV({ key: "f" }), 2)),
    });

    await expect(provider.getFlag("app-A", "env-1", "f")).resolves.toMatchObject({
      flagKey: "f",
    });
  });

  it("fails as STALE and reports a five-second propagation breach", async () => {
    const kv = new FakeKv().put(flagConfigKey("app-A", "env-1", "f"), flagConfigKV({ key: "f" }));
    const breach = vi.fn();
    let now = 0;
    const provider = new KvProvider(kv, {
      configUpdates: updates(async () => snapshot(flagConfigKV({ key: "f" }), 1)),
      now: () => now,
      onPropagationBreach: breach,
    });
    await provider.getFlag("app-A", "env-1", "f");
    provider.invalidate("app-A", "env-1", {
      type: "config.changed",
      entity: "flag",
      id: "flag-id-1",
      version: 2,
    });
    now = 5_000;

    await expect(provider.getFlag("app-A", "env-1", "f")).rejects.toMatchObject({
      errorCode: "SERVICE_UNAVAILABLE",
      resolutionReason: "STALE",
    });
    expect(breach).toHaveBeenCalledWith({
      appId: "app-A",
      environmentId: "env-1",
      announcedVersion: 2,
      servedVersion: 1,
      elapsedMs: 5_000,
    });
  });

  it("classifies an unavailable authoritative read as ERROR without an announced version", async () => {
    const kv = new FakeKv().put(flagConfigKey("app-A", "env-1", "f"), flagConfigKV({ key: "f" }));
    const provider = new KvProvider(kv, {
      configUpdates: updates(async () => {
        throw new Error("DO unavailable");
      }),
    });

    await expect(provider.getFlag("app-A", "env-1", "f")).rejects.toMatchObject({
      errorCode: "SERVICE_UNAVAILABLE",
      resolutionReason: "ERROR",
    });
  });
});

describe("KvProvider.getFlags", () => {
  it("bulk-resolves every flag for an Environment, app-scoped", async () => {
    const kv = new FakeKv()
      .put(flagConfigKey("app-A", "env-1", "f1"), flagConfigKV({ key: "f1", id: "1" }))
      .put(flagConfigKey("app-A", "env-1", "f2"), flagConfigKV({ key: "f2", id: "2" }))
      .put(flagConfigKey("app-B", "env-1", "f3"), flagConfigKV({ key: "f3", id: "3" }));
    const provider = new KvProvider(kv);

    const flags = await provider.getFlags("app-A", "env-1");

    expect(flags.map((f) => f.flagKey).sort()).toEqual(["f1", "f2"]);
    expect(flags.every((f) => f.appId === "app-A")).toBe(true);
  });
});

function updates(
  readCurrentFlagConfig: (
    appId: string,
    environmentId: string,
    flagKey: string,
  ) => Promise<ReturnType<typeof snapshot> | null>,
) {
  let connected = false;
  return {
    async ensureSubscribed(
      _appId: string,
      _environmentId: string,
      listener: { onReconnect(): void },
    ) {
      if (!connected) {
        connected = true;
        listener.onReconnect();
      }
    },
    readCurrentFlagConfig,
  };
}

function snapshot(flag: FlagConfigKV, version = 1) {
  return { flag, experiment: null, run: null, version };
}

describe("KvProvider.getExperiment", () => {
  it("hydrates the live Run inline (one getExperiment call, not two)", async () => {
    const kv = new FakeKv()
      .put(experimentConfigKey("app-A", "env-1", "exp-7"), experimentConfigKV())
      .put("app:app-A:env-1:run:run-42", runConfigKV());
    const provider = new KvProvider(kv);

    const experiment = await provider.getExperiment("app-A", "env-1", "exp-7");

    expect(experiment.liveRunId).toBe("run-42");
    expect(experiment.targetingKeyType).toBe("user");
    expect(experiment.status).toBe("running");
    expect(experiment.liveRun?.targetingKey).toBe("userId");
    expect(experiment.liveRun?.salt).toBe("run-salt-xyz");
  });

  it("returns liveRun null with no Run read when the Experiment has no live Run", async () => {
    const kv = new FakeKv().put(
      experimentConfigKey("app-A", "env-1", "exp-7"),
      experimentConfigKV({ liveRunId: null, status: "draft" }),
    );
    const provider = new KvProvider(kv);

    const experiment = await provider.getExperiment("app-A", "env-1", "exp-7");

    expect(experiment.liveRun).toBeNull();
    expect(experiment.status).toBe("draft");
    expect(kv.getCallsMatching(":run:")).toBe(0);
  });
});
