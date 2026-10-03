import { getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { srmRootCauseBranchCases } from "./srm-root-cause-branch-cases";
import { classifySrmRootCause } from "./srm-root-cause";

describe("classifySrmRootCause branches", () => {
  it.each(srmRootCauseBranchCases())(
    "$name -> $expectedBranch",
    ({ input, expectedBranch, nextCheck }) => {
      const result = classifySrmRootCause(input);
      if (expectedBranch === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result?.branch).toBe(expectedBranch);
      expect(result?.nextCheck).toBe(nextCheck);
      expect(result?.explanation.length).toBeGreaterThan(0);
    },
  );

  it("every branch nextCheck resolves to a registered routeRegistry operation", () => {
    for (const { input, expectedBranch } of srmRootCauseBranchCases()) {
      if (expectedBranch === null) continue;
      const result = classifySrmRootCause(input);
      if (result === null) {
        throw new Error(`expected classification for ${expectedBranch}`);
      }
      expect(getRoute(result.nextCheck), result.nextCheck).toBeDefined();
    }
  });
});
