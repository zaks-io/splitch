import {
  drawRelativeExperiment,
  gaussianFromUniform,
  type RelativeDrawSpec,
  type RelativeExperimentDraw,
  seededUniform,
  trueRelativeLiftPct,
} from "./relative-ci-simulation-draws";
import {
  classifyLook,
  type IntervalMethod,
  type RelativeCoverageConfig,
  type TrialClass,
  trialGuardrail,
} from "./relative-ci-simulation-look";

export const FIELLER_SMOKE_LOOKS = [80, 160, 280] as const;
export const FIELLER_AUDIT_LOOKS = [80, 120, 180, 260, 380, 520, 700, 950, 1_250] as const;

interface IntervalCoverageRates {
  readonly everMiscoverage: number;
  readonly undefinedTrials: number;
  readonly unboundedTrials: number;
}

export interface RelativeCoverageResult {
  readonly seed: string;
  readonly iterations: number;
  readonly kind: RelativeDrawSpec["kind"];
  readonly cuped: boolean;
  readonly trueRelativeLiftPct: number | null;
  readonly fieller: IntervalCoverageRates;
  readonly delta: IntervalCoverageRates;
}

export interface GuardrailSimulationResult {
  readonly seed: string;
  readonly iterations: number;
  readonly fixture: "known-safe" | "known-harmful";
  readonly trueRelativeLiftPct: number | null;
  readonly fiellerEverBreach: number;
  readonly deltaEverBreach: number;
  readonly fiellerLastLookBreach: number;
  readonly deltaLastLookBreach: number;
  readonly fiellerUndetermined: number;
  readonly deltaUndetermined: number;
}

export function runRelativeCoverageSimulation(
  config: RelativeCoverageConfig,
): RelativeCoverageResult {
  const truth = trueRelativeLiftPct(config.spec);
  const fieller = emptyRates();
  const delta = emptyRates();

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const draw = oneDraw(config, iteration);
    accumulateCoverage(fieller, trialCoverage(config, draw, truth, "fieller"));
    accumulateCoverage(delta, trialCoverage(config, draw, truth, "delta"));
  }

  return {
    seed: config.seed,
    iterations: config.iterations,
    kind: config.spec.kind,
    cuped: config.spec.cuped,
    trueRelativeLiftPct: truth,
    fieller: toRates(fieller, config.iterations),
    delta: toRates(delta, config.iterations),
  };
}

export function runGuardrailSimulation(
  config: RelativeCoverageConfig,
  fixture: "known-safe" | "known-harmful",
): GuardrailSimulationResult {
  const fieller = emptyGuardrailAcc();
  const delta = emptyGuardrailAcc();

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const draw = oneDraw(config, iteration);
    addGuardrailTrial(fieller, trialGuardrail(config, draw, "fieller"));
    addGuardrailTrial(delta, trialGuardrail(config, draw, "delta"));
  }

  return {
    seed: config.seed,
    iterations: config.iterations,
    fixture,
    trueRelativeLiftPct: trueRelativeLiftPct(config.spec),
    ...guardrailRates(fieller, delta, config.iterations),
  };
}

interface RateAcc {
  miss: number;
  undefinedTrials: number;
  unboundedTrials: number;
}

interface GuardrailAcc {
  everBreach: number;
  lastLookBreach: number;
  undetermined: number;
}

function emptyRates(): RateAcc {
  return { miss: 0, undefinedTrials: 0, unboundedTrials: 0 };
}

function emptyGuardrailAcc(): GuardrailAcc {
  return { everBreach: 0, lastLookBreach: 0, undetermined: 0 };
}

function addGuardrailTrial(
  acc: GuardrailAcc,
  trial: { everBreach: boolean; lastLookBreach: boolean; undetermined: boolean },
): void {
  if (trial.everBreach) acc.everBreach += 1;
  if (trial.lastLookBreach) acc.lastLookBreach += 1;
  if (trial.undetermined) acc.undetermined += 1;
}

function guardrailRates(fieller: GuardrailAcc, delta: GuardrailAcc, iterations: number) {
  return {
    fiellerEverBreach: fieller.everBreach / iterations,
    deltaEverBreach: delta.everBreach / iterations,
    fiellerLastLookBreach: fieller.lastLookBreach / iterations,
    deltaLastLookBreach: delta.lastLookBreach / iterations,
    fiellerUndetermined: fieller.undetermined / iterations,
    deltaUndetermined: delta.undetermined / iterations,
  };
}

function toRates(acc: RateAcc, iterations: number): IntervalCoverageRates {
  return {
    everMiscoverage: acc.miss / iterations,
    undefinedTrials: acc.undefinedTrials / iterations,
    unboundedTrials: acc.unboundedTrials / iterations,
  };
}

function accumulateCoverage(acc: RateAcc, trial: { classes: readonly TrialClass[] }): void {
  if (trial.classes.includes("miss")) acc.miss += 1;
  if (trial.classes.every((item) => item === "undefined")) acc.undefinedTrials += 1;
  if (trial.classes.includes("unbounded") && !trial.classes.includes("miss")) {
    acc.unboundedTrials += 1;
  }
}

function oneDraw(config: RelativeCoverageConfig, iteration: number): RelativeExperimentDraw {
  const uniform = seededUniform(`${config.seed}:${iteration}`);
  return drawRelativeExperiment(
    uniform,
    gaussianFromUniform(uniform),
    config.spec,
    Math.max(...config.lookSchedule),
  );
}

function trialCoverage(
  config: RelativeCoverageConfig,
  draw: RelativeExperimentDraw,
  truth: number | null,
  method: IntervalMethod,
): { classes: TrialClass[] } {
  return {
    classes: config.lookSchedule.map((look) => classifyLook(config, draw, look, truth, method)),
  };
}
