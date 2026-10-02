import { describe, expect, it } from "vitest";
import { canonicalHash } from "./canonical-json";
import { stats } from "./experiment-decision-gate-test-fixtures";
import {
  CURRENT_ANALYSIS_VERSION,
  createResultToken,
  LEGACY_RUN_COMMITMENTS,
  RunCommitmentsSchema,
  SUPPORTED_ANALYSIS_VERSIONS,
} from "./run-commitments";

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

  it("supports the version new Runs freeze", () => {
    expect(SUPPORTED_ANALYSIS_VERSIONS).toContain(CURRENT_ANALYSIS_VERSION);
  });
});

describe("RunCommitmentsSchema", () => {
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
