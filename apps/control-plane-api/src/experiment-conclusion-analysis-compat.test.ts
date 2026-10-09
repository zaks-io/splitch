import { ConcludeRunResponseSchema } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { concludeRun } from "./experiment-conclusion-handler";
import {
  APP_ID,
  conclusionFixture,
  readyEnvelope,
  resultToken,
  runRow,
  WATERMARK,
} from "./experiment-conclusion-handler-test-fixtures";
import { approvalRow } from "./experiment-conclusion-replay-test-fixtures";
import { statsOutput } from "./panel-experiments-test-fixtures";

function successfulCommit(fixture: ReturnType<typeof conclusionFixture>) {
  fixture.commit.mockImplementation(async (_scope, input) => {
    vi.mocked(fixture.repo.experimentConclusions.get).mockResolvedValue({
      ...input.conclusion,
      appId: APP_ID,
    });
    vi.mocked(fixture.repo.experiments.getRun).mockResolvedValue(runRow("ended"));
    vi.mocked(fixture.repo.approvals.getRequest).mockResolvedValue({
      ...approvalRow(),
      ...input.approval,
    });
    return { ok: true };
  });
}

describe("Conclude Analysis response compatibility", () => {
  it("concludes with identical token and Conclusion evidence after stripping additive fields", async () => {
    const stats = statsOutput();
    const token = await resultToken(stats);
    const clean = conclusionFixture({
      expectedResultToken: token,
      analysisEnvelope: readyEnvelope(stats, token),
    });
    const additive = conclusionFixture({ expectedResultToken: token });
    additive.analysis.mockResolvedValue(
      Response.json({
        ...readyEnvelope(stats, token),
        future_analysis_field: { revision: 2 },
        stats: {
          ...stats,
          arm_results: stats.arm_results.map((arm) => ({ ...arm, future_arm_field: 42 })),
        },
      }),
    );
    successfulCommit(clean);
    successfulCommit(additive);

    const cleanResponse = await concludeRun(clean.deps, clean.args);
    const additiveResponse = await concludeRun(additive.deps, additive.args);
    const body = await additiveResponse.json();

    expect(cleanResponse.status).toBe(200);
    expect(additiveResponse.status).toBe(200);
    expect(ConcludeRunResponseSchema.safeParse(body).success).toBe(true);
    expect(body.conclusion).toMatchObject({ resultToken: token, dataWatermark: WATERMARK });
    const cleanConclusion = clean.commit.mock.calls[0]?.[1].conclusion;
    const additiveConclusion = additive.commit.mock.calls[0]?.[1].conclusion;
    expect(additiveConclusion).toMatchObject({
      resultToken: cleanConclusion.resultToken,
      dataWatermark: cleanConclusion.dataWatermark,
      resultSnapshot: cleanConclusion.resultSnapshot,
      decisionChecks: cleanConclusion.decisionChecks,
      decisionFailures: cleanConclusion.decisionFailures,
    });
    expect(JSON.parse(additiveConclusion.resultSnapshot)).toEqual(stats);
  });

  it.each([undefined, "0.8"])(
    "fails loud on a missing or mistyped required arm estimate (%s) and writes nothing",
    async (pointEstimate) => {
      const stats = statsOutput();
      const token = await resultToken(stats);
      const fixture = conclusionFixture({ expectedResultToken: token });
      fixture.analysis.mockResolvedValue(
        Response.json({
          ...readyEnvelope(stats, token),
          future_analysis_field: 1,
          stats: {
            ...stats,
            arm_results: stats.arm_results.map((arm) => ({
              ...arm,
              point_estimate: pointEstimate,
              future_arm_field: 42,
            })),
          },
        }),
      );

      await expect(concludeRun(fixture.deps, fixture.args)).rejects.toThrow();
      expect(fixture.commit).not.toHaveBeenCalled();
    },
  );
});
