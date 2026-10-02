import { describe, expect, it } from "vitest";
import {
  FIELLER_AUDIT_LOOKS,
  runGuardrailSimulation,
  runRelativeCoverageSimulation,
} from "../src/relative-ci-simulation";
import { coverageScenarios, guardrailSpec } from "../src/relative-ci-simulation-draws";
import { FIELLER_SIMULATION_ALPHA } from "../src/relative-ci-simulation-look";
import { monteCarloTolerance } from "../src/sequential-ci-simulation";

const SEED = "424242";
// Heavy 300-iteration table lives in `stats:simulation --mode=audit`. This file
// keeps `stats:audit` from growing by another full minute.
const ITERATIONS = 80;

describe("Fieller coverage audit (heavy)", () => {
  const tolerance = monteCarloTolerance(FIELLER_SIMULATION_ALPHA, ITERATIONS);
  const lookSchedule = FIELLER_AUDIT_LOOKS;
  const target_n = Math.max(...lookSchedule);

  it("records time-uniform coverage versus the delta-method comparator", {
    timeout: 600_000,
  }, () => {
    const table: string[] = [];
    for (const spec of coverageScenarios()) {
      const result = runRelativeCoverageSimulation({
        seed: `${SEED}:${spec.kind}:${spec.cuped ? "cuped" : "raw"}`,
        iterations: ITERATIONS,
        lookSchedule,
        spec,
        target_n,
      });
      table.push(
        `${spec.kind}\tcuped=${spec.cuped}\tfieller=${result.fieller.everMiscoverage.toFixed(4)}\t` +
          `delta=${result.delta.everMiscoverage.toFixed(4)}\tunbounded=${result.fieller.unboundedTrials.toFixed(4)}`,
      );
      expect(result.fieller.everMiscoverage).toBeLessThanOrEqual(
        FIELLER_SIMULATION_ALPHA + tolerance,
      );
    }
    console.info(`Fieller audit seed=${SEED} iterations=${ITERATIONS} tolerance=${tolerance}`);
    console.info(table.join("\n"));
  });

  it("records Guardrail breach rates on known-safe and known-harmful fixtures", {
    timeout: 300_000,
  }, () => {
    for (const fixture of ["known-safe", "known-harmful"] as const) {
      const result = runGuardrailSimulation(
        {
          seed: `${SEED}:guardrail:${fixture}`,
          iterations: ITERATIONS,
          lookSchedule,
          spec: guardrailSpec(fixture),
          target_n,
        },
        fixture,
      );
      console.info(
        `Guardrail audit ${fixture} fiellerLast=${result.fiellerLastLookBreach} ` +
          `deltaLast=${result.deltaLastLookBreach} fiellerEver=${result.fiellerEverBreach} ` +
          `deltaEver=${result.deltaEverBreach} undetermined=${result.fiellerUndetermined}`,
      );
      if (fixture === "known-safe") {
        expect(result.fiellerLastLookBreach).toBeLessThan(0.25);
      } else {
        expect(result.fiellerLastLookBreach).toBeGreaterThan(0.5);
      }
    }
  });
});
