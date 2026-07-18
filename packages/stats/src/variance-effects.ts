import type { VarianceTechniques } from "@splitch/contracts";
import type {
  MetricArmEstimate,
  MetricComparisonEstimate,
  MetricComparisonEstimateInput,
} from "./variance-estimator-types";
import { clampSamplingVariance } from "./variance-math";

export function comparisonEstimate(
  input: MetricComparisonEstimateInput,
  control: MetricArmEstimate,
  treatment: MetricArmEstimate,
  variance_techniques: VarianceTechniques,
): MetricComparisonEstimate {
  return {
    metric_id: input.metric_id,
    metric_type: input.metric_type,
    control,
    treatment,
    variance_techniques,
    ...absoluteLiftEffect(control, treatment),
    ...relativeLiftEffect(control, treatment),
  };
}

function absoluteLiftEffect(
  control: MetricArmEstimate,
  treatment: MetricArmEstimate,
): Pick<MetricComparisonEstimate, "absolute_lift" | "absolute_lift_sampling_var"> {
  const absoluteLift =
    treatment.point_estimate === null || control.point_estimate === null
      ? null
      : treatment.point_estimate - control.point_estimate;
  const samplingVar =
    treatment.sampling_var === null || control.sampling_var === null
      ? null
      : treatment.sampling_var + control.sampling_var;

  return {
    absolute_lift: absoluteLift,
    absolute_lift_sampling_var: boundarySafeAbsoluteLiftSamplingVar(
      control,
      treatment,
      absoluteLift,
      samplingVar,
    ),
  };
}

function boundarySafeAbsoluteLiftSamplingVar(
  control: MetricArmEstimate,
  treatment: MetricArmEstimate,
  absoluteLift: number | null,
  samplingVar: number | null,
): number | null {
  if (
    samplingVar === null ||
    samplingVar !== 0 ||
    absoluteLift === null ||
    absoluteLift === 0 ||
    control.metric_type !== "binomial" ||
    treatment.metric_type !== "binomial"
  ) {
    return samplingVar;
  }

  return agrestiCaffoSamplingVar(control) + agrestiCaffoSamplingVar(treatment);
}

function agrestiCaffoSamplingVar(arm: MetricArmEstimate): number {
  const pointEstimate = arm.point_estimate;
  if (pointEstimate === null || arm.sample_size_n === 0) {
    throw new Error("Agresti-Caffo boundary variance requires a non-empty Binomial arm.");
  }

  const adjustedN = arm.sample_size_n + 2;
  const adjustedRate = (pointEstimate * arm.sample_size_n + 1) / adjustedN;
  return (adjustedRate * (1 - adjustedRate)) / adjustedN;
}

function relativeLiftEffect(
  control: MetricArmEstimate,
  treatment: MetricArmEstimate,
): Pick<MetricComparisonEstimate, "relative_lift_pct" | "sampling_var" | "status"> {
  if (control.status !== "ready" || treatment.status !== "ready") {
    return {
      relative_lift_pct: null,
      sampling_var: null,
      status:
        control.status === "insufficient_denominator" ||
        treatment.status === "insufficient_denominator"
          ? "insufficient_denominator"
          : "running",
    };
  }

  const values = readyRelativeValues(control, treatment);
  if (!values || values.controlPoint === 0) {
    return { relative_lift_pct: null, sampling_var: null, status: "insufficient_denominator" };
  }

  const relativeLift = values.treatmentPoint / values.controlPoint - 1;
  const samplingVar =
    (values.treatmentSamplingVar / values.controlPoint ** 2 +
      (values.treatmentPoint ** 2 * values.controlSamplingVar) / values.controlPoint ** 4) *
    10_000;

  return {
    relative_lift_pct: relativeLift * 100,
    sampling_var: boundarySafeRelativeLiftSamplingVar(
      control,
      treatment,
      relativeLift,
      clampSamplingVariance(samplingVar),
    ),
    status: "ready",
  };
}

function boundarySafeRelativeLiftSamplingVar(
  control: MetricArmEstimate,
  treatment: MetricArmEstimate,
  relativeLift: number,
  samplingVar: number,
): number {
  if (
    samplingVar !== 0 ||
    relativeLift === 0 ||
    control.metric_type !== "binomial" ||
    treatment.metric_type !== "binomial" ||
    control.point_estimate === null ||
    treatment.point_estimate === null ||
    control.sampling_var === null ||
    treatment.sampling_var === null
  ) {
    return samplingVar;
  }

  const controlSamplingVar =
    control.sampling_var === 0 ? agrestiCaffoSamplingVar(control) : control.sampling_var;
  const treatmentSamplingVar =
    treatment.sampling_var === 0 ? agrestiCaffoSamplingVar(treatment) : treatment.sampling_var;

  return clampSamplingVariance(
    (treatmentSamplingVar / control.point_estimate ** 2 +
      (treatment.point_estimate ** 2 * controlSamplingVar) / control.point_estimate ** 4) *
      10_000,
  );
}

function readyRelativeValues(control: MetricArmEstimate, treatment: MetricArmEstimate) {
  const controlPoint = control.point_estimate;
  const treatmentPoint = treatment.point_estimate;
  const controlSamplingVar = control.sampling_var;
  const treatmentSamplingVar = treatment.sampling_var;

  if (
    controlPoint === null ||
    treatmentPoint === null ||
    controlSamplingVar === null ||
    treatmentSamplingVar === null
  ) {
    return null;
  }

  return { controlPoint, treatmentPoint, controlSamplingVar, treatmentSamplingVar };
}
