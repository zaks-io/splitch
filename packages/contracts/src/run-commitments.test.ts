import { describe, expect, it } from "vitest";
import { canonicalHash } from "./canonical-json";
import { armResult, stats } from "./experiment-decision-gate-test-fixtures";
import {
  CURRENT_ANALYSIS_VERSION,
  createResultToken,
  LEGACY_RUN_COMMITMENTS,
  RunCommitmentsSchema,
  SUPPORTED_ANALYSIS_VERSIONS,
} from "./run-commitments";
import { AnalysisResultsEnvelopeSchema } from "./stats-result-contract";

const identity = {
  appId: "app_1",
  environmentId: "env_1",
  experimentId: "exp_1",
  runId: "run_1",
  runConfigHash: `sha256:${"a".repeat(64)}`,
  stats: stats(),
};

describe("result token analysis version (ADR-0059)", () => {
  it("is deterministic for the same evidence and version", async () => {
    const first = await createResultToken({ ...identity, analysisVersion: "analysis-v1" });
    const second = await createResultToken({ ...identity, analysisVersion: "analysis-v1" });

    expect(first).toBe(second);
  });

  it("changes on a deliberate version change with the raw evidence unchanged", async () => {
    const before = await createResultToken({ ...identity, analysisVersion: "analysis-v1" });
    const after = await createResultToken({ ...identity, analysisVersion: "analysis-v2" });

    expect(after).not.toBe(before);
  });

  it("hashes a legacy Run exactly as the evidence identity did before versioning", async () => {
    expect(await createResultToken({ ...identity, analysisVersion: null })).toBe(
      await canonicalHash(identity),
    );
  });

  it("strips the estimand disclosure on a versioned Run as on a legacy one", async () => {
    const disclosed = stats({
      arm_results: [
        armResult({
          estimand: {
            label: "capped_additive_mean",
            decision_label: "capped_additive_mean",
            capped_entity_count: 1,
            uncapped: {
              label: "uncapped_additive_mean",
              point_estimate: 0.5,
              relative_lift_pct: 8,
              ci_lower: 0.1,
              ci_upper: 12,
              p_value: 0.02,
              status: "ready",
              cuped_applied: false,
            },
          },
        }),
      ],
    });

    for (const analysisVersion of [null, "analysis-v1"]) {
      expect(await createResultToken({ ...identity, stats: disclosed, analysisVersion })).toBe(
        await createResultToken({ ...identity, analysisVersion }),
      );
    }
  });

  it("supports every named version this deployment can analyze", () => {
    // analysis-v2 stays defined in the exhaustive switch but is unsupported
    // until an ingestion-ordered observation path lands (ADR-0059).
    expect(SUPPORTED_ANALYSIS_VERSIONS).toEqual(["analysis-v1"]);
    expect(SUPPORTED_ANALYSIS_VERSIONS).toContain(CURRENT_ANALYSIS_VERSION);
    expect(SUPPORTED_ANALYSIS_VERSIONS).not.toContain("analysis-v2");
    expect(CURRENT_ANALYSIS_VERSION).toBe("analysis-v1");
  });
});

describe("ready results envelope compatibility", () => {
  it("still parses a ready envelope from before run_commitments existed", () => {
    const parsed = AnalysisResultsEnvelopeSchema.parse({
      state: "ready",
      run_id: "run_1",
      control_variant: "control",
      data_watermark: "2026-07-05T00:00:00.000Z",
      result_token: `sha256:${"b".repeat(64)}`,
      stats: stats(),
    });

    expect(parsed.state === "ready" && parsed.run_commitments).toBeUndefined();
  });
});

describe("RunCommitmentsSchema", () => {
  it("bounds a frozen planned duration at a year", () => {
    const frozen = {
      analysis_version_source: "frozen",
      analysis_version: CURRENT_ANALYSIS_VERSION,
      target_n: 5000,
      target_n_source: "default",
      planned_duration_override_reason: null,
    };
    expect(RunCommitmentsSchema.safeParse({ ...frozen, planned_duration_days: 365 }).success).toBe(
      true,
    );
    expect(
      RunCommitmentsSchema.safeParse({ ...frozen, planned_duration_days: 100_000_005 }).success,
    ).toBe(false);
  });

  it("never lets a legacy Run carry a target or duration commitment", () => {
    expect(RunCommitmentsSchema.parse(LEGACY_RUN_COMMITMENTS)).toEqual(LEGACY_RUN_COMMITMENTS);
    expect(
      RunCommitmentsSchema.safeParse({ ...LEGACY_RUN_COMMITMENTS, planned_duration_days: 7 })
        .success,
    ).toBe(false);
  });

  it("requires a frozen Run to carry its planned duration", () => {
    expect(
      RunCommitmentsSchema.safeParse({
        analysis_version_source: "frozen",
        analysis_version: CURRENT_ANALYSIS_VERSION,
        target_n: 5000,
        target_n_source: "default",
        planned_duration_days: null,
        planned_duration_override_reason: null,
      }).success,
    ).toBe(false);
  });
});
