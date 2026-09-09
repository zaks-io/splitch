import { describe, expect, it } from "vitest";
import { concludeRun } from "./experiment-conclusion-handler";
import {
  conclusionFixture,
  readyEnvelope,
  resultToken,
} from "./experiment-conclusion-handler-test-fixtures";
import { statsOutput } from "./panel-experiments-test-fixtures";

describe("concludeRun guarded transaction races", () => {
  it("returns TARGET_CONFIGURATION_STALE when the target changes inside the commit seam", async () => {
    const stats = statsOutput();
    const token = await resultToken(stats);
    const fixture = conclusionFixture({
      expectedResultToken: token,
      analysisEnvelope: readyEnvelope(stats, token),
    });
    fixture.commit.mockImplementation(async () => {
      fixture.readTargetConfig.mockResolvedValue({ version: 2 });
      throw new Error("D1_ERROR: malformed JSON");
    });

    const response = await concludeRun(fixture.deps, fixture.args);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "TARGET_CONFIGURATION_STALE",
      details: {
        flagId: "flag_conclusion",
        environmentId: "env_conclusion",
        expectedConfigVersion: 1,
        currentConfigVersion: 2,
      },
    });
    expect(fixture.commit).toHaveBeenCalledOnce();
  });

  it("rethrows the original D1 error when every fresh guard still passes", async () => {
    const stats = statsOutput();
    const token = await resultToken(stats);
    const fixture = conclusionFixture({
      expectedResultToken: token,
      analysisEnvelope: readyEnvelope(stats, token),
    });
    const cause = new Error("D1_ERROR: Network connection lost");
    fixture.commit.mockRejectedValue(cause);

    await expect(concludeRun(fixture.deps, fixture.args)).rejects.toBe(cause);
  });
});
