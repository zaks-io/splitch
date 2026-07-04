import { describe, expect, it } from "vitest";
import { experimentConfigKV, flagConfigKV, runConfigKV } from "./fixtures";
import { ProviderError } from "./provider";
import { experimentConfigFromKV, flagConfigFromKV } from "./resolve";

describe("flagConfigFromKV", () => {
  it("resolves defaultVariantId (id) into defaultVariant (name)", () => {
    const config = flagConfigFromKV("app-A", flagConfigKV());
    expect(config.defaultVariant).toBe("control");
  });

  it("carries experimentId straight through from the flag blob (no second lookup)", () => {
    expect(flagConfigFromKV("app-A", flagConfigKV({ experimentId: "exp-99" })).experimentId).toBe(
      "exp-99",
    );
    expect(flagConfigFromKV("app-A", flagConfigKV({ experimentId: null })).experimentId).toBeNull();
  });

  it("stamps the appId passed in (the isolation scope), not a blob field", () => {
    expect(flagConfigFromKV("app-A", flagConfigKV()).appId).toBe("app-A");
  });

  it("throws ProviderError when defaultVariantId names no Variant (fail-loud)", () => {
    expect(() => flagConfigFromKV("app-A", flagConfigKV({ defaultVariantId: "v-ghost" }))).toThrow(
      ProviderError,
    );
  });
});

describe("experimentConfigFromKV", () => {
  it("hydrates the live Run inline as an assign()-shaped RunConfig", () => {
    const config = experimentConfigFromKV("app-A", experimentConfigKV(), runConfigKV());
    expect(config.liveRun).toEqual({
      runId: "run-42",
      salt: "run-salt-xyz",
      allocation: { control: 50, treatment: 50 },
      variantSet: runConfigKV().variantSet,
      targetingRules: [],
      targetingKey: "userId",
    });
  });

  it("surfaces targetingKeyType (the Exposure id_type) and status on the view", () => {
    const config = experimentConfigFromKV(
      "app-A",
      experimentConfigKV({ targetingKeyType: "workspace", status: "running" }),
      runConfigKV(),
    );
    expect(config.targetingKeyType).toBe("workspace");
    expect(config.status).toBe("running");
  });

  it("returns liveRun null when no Run is live", () => {
    const config = experimentConfigFromKV(
      "app-A",
      experimentConfigKV({ liveRunId: null, status: "draft" }),
      null,
    );
    expect(config.liveRun).toBeNull();
    expect(config.liveRunId).toBeNull();
    expect(config.status).toBe("draft");
  });

  it("throws when liveRunId is set but no Run config is supplied (fail-loud)", () => {
    expect(() => experimentConfigFromKV("app-A", experimentConfigKV(), null)).toThrow(
      ProviderError,
    );
  });

  it("throws when the Run id disagrees with liveRunId (fail-loud)", () => {
    expect(() =>
      experimentConfigFromKV("app-A", experimentConfigKV(), runConfigKV({ id: "run-other" })),
    ).toThrow(ProviderError);
  });

  it("throws when the Run belongs to a different Experiment (fail-loud)", () => {
    expect(() =>
      experimentConfigFromKV(
        "app-A",
        experimentConfigKV(),
        runConfigKV({ experimentId: "exp-other" }),
      ),
    ).toThrow(ProviderError);
  });
});
