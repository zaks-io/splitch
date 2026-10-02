import { describe, expect, it } from "vitest";
import {
  FIELLER_AUDIT_LOOKS,
  FIELLER_SMOKE_LOOKS,
  type RelativeCoverageResult,
  runGuardrailSimulation,
  runRelativeCoverageSimulation,
} from "./relative-ci-simulation";
import { coverageScenarios, guardrailSpec } from "./relative-ci-simulation-draws";
import { FIELLER_SIMULATION_ALPHA } from "./relative-ci-simulation-look";
import { monteCarloTolerance } from "./sequential-ci-simulation";

describe("Fieller sequential coverage audit", () => {
  const mode = process.env.SPLITCH_STATS_SIMULATION_MODE === "audit" ? "audit" : "smoke";
  const seed = process.env.SPLITCH_STATS_SIMULATION_SEED ?? "424242";
  const requested = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "40", 10);
  const iterations = mode === "audit" ? requested : Math.min(requested, 40);
  const lookSchedule = mode === "audit" ? FIELLER_AUDIT_LOOKS : FIELLER_SMOKE_LOOKS;
  const tolerance = monteCarloTolerance(FIELLER_SIMULATION_ALPHA, iterations);
  const target_n = Math.max(...lookSchedule);

  it("holds time-uniform Fieller coverage across Metric kinds", { timeout: 300_000 }, () => {
    const rows: RelativeCoverageResult[] = [];
    for (const spec of coverageScenarios()) {
      const result = runRelativeCoverageSimulation({
        seed: `${seed}:${spec.kind}:${spec.cuped ? "cuped" : "raw"}`,
        iterations,
        lookSchedule,
        spec,
        target_n,
      });
      rows.push(result);
      console.info(
        `Fieller ${mode} ${spec.kind} cuped=${spec.cuped} seed=${result.seed} n=${iterations} ` +
          `fieller=${result.fieller.everMiscoverage} delta=${result.delta.everMiscoverage} ` +
          `unbounded=${result.fieller.unboundedTrials} tolerance=${tolerance}`,
      );
      expect(
        result.fieller.everMiscoverage,
        `${spec.kind} cuped=${spec.cuped} Fieller ever-miscoverage`,
      ).toBeLessThanOrEqual(FIELLER_SIMULATION_ALPHA + tolerance);
    }
    expect(rows).toHaveLength(coverageScenarios().length);
  });

  it("records signed, zero, and near-zero Control-mean domain behavior", {
    timeout: 120_000,
  }, () => {
    for (const testCase of domainCases()) {
      const result = runRelativeCoverageSimulation({
        seed: `${seed}:domain:${testCase.label}`,
        iterations,
        lookSchedule,
        spec: testCase.spec,
        target_n,
      });
      console.info(
        `Domain ${mode} ${testCase.label} undefined=${result.fieller.undefinedTrials} ` +
          `unbounded=${result.fieller.unboundedTrials} miss=${result.fieller.everMiscoverage}`,
      );
      expectDomain(testCase.label, result);
    }
  });

  it("compares Guardrail breach rates on known-safe and known-harmful fixtures", {
    timeout: 180_000,
  }, () => {
    for (const fixture of ["known-safe", "known-harmful"] as const) {
      const result = runGuardrailSimulation(
        {
          seed: `${seed}:guardrail:${fixture}`,
          iterations,
          lookSchedule,
          spec: guardrailSpec(fixture),
          target_n,
        },
        fixture,
      );
      console.info(
        `Guardrail ${mode} ${fixture} seed=${result.seed} n=${iterations} ` +
          `fiellerLast=${result.fiellerLastLookBreach} deltaLast=${result.deltaLastLookBreach} ` +
          `fiellerEver=${result.fiellerEverBreach} deltaEver=${result.deltaEverBreach} ` +
          `undetermined=${result.fiellerUndetermined}`,
      );
      expectGuardrail(fixture, result);
    }
  });
});

function domainCases() {
  return [
    {
      label: "zero" as const,
      spec: { kind: "binomial" as const, controlMean: 0, treatmentMean: 0.5, cuped: false },
    },
    {
      label: "signed" as const,
      spec: {
        kind: "count" as const,
        controlMean: -12,
        treatmentMean: -9,
        cuped: false,
        spread: 1.5,
      },
    },
    {
      label: "near-zero" as const,
      spec: {
        kind: "count" as const,
        controlMean: 0.04,
        treatmentMean: 6,
        cuped: false,
        spread: 7,
      },
    },
  ];
}

function expectDomain(
  label: "zero" | "signed" | "near-zero",
  result: RelativeCoverageResult,
): void {
  if (label === "zero") {
    expect(result.fieller.undefinedTrials).toBe(1);
    expect(result.trueRelativeLiftPct).toBeNull();
    return;
  }
  if (label === "signed") {
    expect(result.fieller.undefinedTrials).toBe(0);
    expect(result.fieller.unboundedTrials).toBe(0);
    return;
  }
  expect(result.fieller.unboundedTrials).toBeGreaterThan(0.5);
}

function expectGuardrail(
  fixture: "known-safe" | "known-harmful",
  result: { fiellerLastLookBreach: number; fiellerUndetermined: number },
): void {
  if (fixture === "known-safe") {
    expect(result.fiellerLastLookBreach).toBeLessThan(0.5);
    return;
  }
  expect(result.fiellerLastLookBreach).toBeGreaterThan(result.fiellerUndetermined);
  expect(result.fiellerLastLookBreach).toBeGreaterThan(0.2);
}
