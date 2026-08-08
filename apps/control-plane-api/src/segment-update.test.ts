import { describe, expect, it } from "vitest";
import type { MetricSegmentDeps } from "./metric-segment-shared";
import type { SegmentDependencies } from "./segment-dependencies";
import { renderRepublishFailure, republishFlagConfigurations } from "./segment-republication";

describe("Segment dependent Flag Configuration publication", () => {
  it("reports every Flag Configuration that was and was not republished", async () => {
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
        writerFor: () => ({
          resyncFlagConfig: async ({ flagId }: { flagId: string }) =>
            flagId === "flag_b"
              ? { ok: false as const, reason: "FLAG_NOT_FOUND" as const }
              : { ok: true as const, config: {}, nudge: {} },
        }),
      },
    } as unknown as MetricSegmentDeps;

    await expect(republishFlagConfigurations(deps, "app_a", dependencies)).resolves.toEqual({
      segmentApplied: true,
      republishedFlagConfigurations: [
        expect.objectContaining({ environmentId: "env_a", flagId: "flag_a" }),
        expect.objectContaining({ environmentId: "env_b", flagId: "flag_c" }),
        expect.objectContaining({ environmentId: "env_c", flagId: "flag_d" }),
      ],
      notRepublishedFlagConfigurations: [
        expect.objectContaining({
          environmentId: "env_a",
          flagId: "flag_b",
          reason: "FLAG_NOT_FOUND",
        }),
      ],
    });
  });

  it("returns RUN_FROZEN with the blocking Run and complete Flag Configuration lists", async () => {
    const response = renderRepublishFailure("request_a", {
      segmentApplied: true,
      republishedFlagConfigurations: [identity("env_a", "flag_a")],
      notRepublishedFlagConfigurations: [
        {
          ...identity("env_b", "flag_b"),
          reason: "RUN_FROZEN",
          frozenFields: ["flagConfig.targetingRules"],
          currentRunId: "run_b",
          attemptedChange: "REPLACE_TARGETING_RULES:flag_b",
        },
      ],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "RUN_FROZEN",
      details: {
        currentRunId: "run_b",
        recommendedAction: "END_RUNNING_RUN_FIRST",
        republishedFlagConfigurations: [expect.objectContaining({ flagId: "flag_a" })],
        notRepublishedFlagConfigurations: [
          expect.objectContaining({ flagId: "flag_b", reason: "RUN_FROZEN" }),
        ],
      },
    });
  });

  it("says the Segment did not change when the refusal landed before the D1 write", async () => {
    const response = renderRepublishFailure("request_a", {
      segmentApplied: false,
      republishedFlagConfigurations: [],
      notRepublishedFlagConfigurations: [
        {
          ...identity("env_b", "flag_b"),
          reason: "RUN_FROZEN",
          frozenFields: ["flagConfig.targetingRules"],
          currentRunId: "run_b",
          attemptedChange: "UPDATE_SEGMENT_CONDITIONS:flag_b",
        },
      ],
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { message: string; details: Record<string, unknown> };
    expect(body.message).toBe("Segment Conditions were not changed because a Run is active");
    // The applied/not-applied discriminator drives the message; it is not part of
    // the wire contract and must not surface as a details field.
    expect(body.details).not.toHaveProperty("segmentApplied");
  });

  it("reports zero-success faults honestly and carries every reason", async () => {
    const dependencies = {
      flagConfigurations: [dependency("env_a", "flag_a"), dependency("env_a", "flag_b")],
      experimentDrafts: [],
    } satisfies SegmentDependencies;
    const deps = {
      configStore: {
        writerFor: () => ({
          resyncFlagConfig: async ({ flagId }: { flagId: string }) => {
            throw new Error(`fault:${flagId}`);
          },
        }),
      },
    } as unknown as MetricSegmentDeps;

    const failure = await republishFlagConfigurations(deps, "app_a", dependencies);
    if (!failure) throw new Error("expected Segment republication failure");
    const response = renderRepublishFailure("request_a", failure);
    const body = (await response.json()) as {
      message: string;
      details: { notRepublishedFlagConfigurations: Array<{ reason: string; fault?: string }> };
    };

    expect(response.status).toBe(500);
    expect(body.message).toBe(
      "Segment changed, but dependent Flag Configurations were not republished",
    );
    expect(body.details.notRepublishedFlagConfigurations.map(({ reason }) => reason)).toEqual([
      "UNEXPECTED_ERROR",
      "UNEXPECTED_ERROR",
    ]);
    expect(body.details.notRepublishedFlagConfigurations.map(({ fault }) => fault)).toEqual([
      "fault:flag_a",
      "fault:flag_b",
    ]);
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

function identity(environmentId: string, flagId: string) {
  const { targetingRuleIds: _, ...value } = dependency(environmentId, flagId);
  return value;
}
