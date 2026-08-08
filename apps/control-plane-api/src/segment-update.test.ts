import { describe, expect, it } from "vitest";
import type { MetricSegmentDeps } from "./metric-segment-shared";
import type { SegmentDependencies } from "./segment-dependencies";
import { renderRepublishFailure, republishFlagConfigurations } from "./segment-republication";

describe("Segment dependent Flag Configuration publication", () => {
  it("reports every Environment that was and was not republished", async () => {
    const dependencies = {
      flagConfigurations: [
        dependency("env_a", "flag_a"),
        dependency("env_a", "flag_b"),
        dependency("env_b", "flag_c"),
        dependency("env_c", "flag_d"),
      ],
      experimentDrafts: [],
    } satisfies SegmentDependencies;
    const deps = {
      configStore: {
        writerFor: (_appId: string, environmentId: string) => ({
          resyncFlagConfig: async () =>
            environmentId === "env_b"
              ? { ok: false as const, reason: "FLAG_NOT_FOUND" as const }
              : { ok: true as const, config: {}, nudge: {} },
        }),
      },
    } as unknown as MetricSegmentDeps;

    await expect(republishFlagConfigurations(deps, "app_a", dependencies)).resolves.toEqual({
      republishedEnvironmentIds: ["env_a", "env_c"],
      notRepublishedEnvironmentIds: ["env_b"],
    });
  });

  it("returns both complete Environment lists to the operator", async () => {
    const response = renderRepublishFailure("request_a", {
      republishedEnvironmentIds: ["env_a", "env_c"],
      notRepublishedEnvironmentIds: ["env_b", "env_d"],
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      details: {
        republishedEnvironmentIds: ["env_a", "env_c"],
        notRepublishedEnvironmentIds: ["env_b", "env_d"],
      },
    });
  });
});

function dependency(environmentId: string, flagId: string) {
  return {
    flagConfigurationId: `config_${flagId}`,
    flagId,
    flagKey: flagId,
    flagName: flagId,
    environmentId,
    environmentKey: environmentId,
    environmentName: environmentId,
    targetingRuleIds: [`rule_${flagId}`],
  };
}
