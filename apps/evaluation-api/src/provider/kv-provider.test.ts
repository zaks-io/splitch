import { experimentConfigKey, flagConfigKey } from "@splitch/contracts";
import type { DeltaNudge } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { FakeKv } from "./fake-kv.js";
import { experimentConfigKV, flagConfigKV, runConfigKV } from "./fixtures.js";
import { KvProvider } from "./kv-provider.js";

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
    const provider = new KvProvider(kv);
    const nudge: DeltaNudge = {
      type: "config.changed",
      entity: "flag",
      id: "flag-id-1",
      version: 3,
    };

    await provider.getFlag("app-A", "env-1", "f");
    provider.invalidate("app-A", nudge);
    await provider.getFlag("app-A", "env-1", "f");

    expect(kv.getCalls).toHaveLength(2);
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
