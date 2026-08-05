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
): Pick<
  MetricComparisonEstimate,
  "absolute_lift" | "absolute_lift_sampling_var" | "absolute_lift_var_components"
> {
  const absoluteLift =
    treatment.point_estimate === null || control.point_estimate === null
      ? null
      : treatment.point_estimate - control.point_estimate;
  const samplingVar =
    treatment.sampling_var === null || control.sampling_var === null
      ? null
      : treatment.sampling_var + control.sampling_var;

  if (!boundarySubstitutionApplies(control, treatment, absoluteLift, samplingVar)) {
    return {
      absolute_lift: absoluteLift,
      absolute_lift_sampling_var: samplingVar,
      absolute_lift_var_components:
        control.sampling_var === null || treatment.sampling_var === null
          ? null
          : { control: control.sampling_var, treatment: treatment.sampling_var },
    };
  }

  const components = {
    control: boundarySafeArmSamplingVar(control),
    treatment: boundarySafeArmSamplingVar(treatment),
  };

  return {
    absolute_lift: absoluteLift,
    absolute_lift_sampling_var: components.control + components.treatment,
    absolute_lift_var_components: components,
  };
}

/**
 * A Binomial arm at 0% or 100% has p(1-p) = 0 and so contributes exactly zero
 * variance. Guarding on the total only catches the case where both arms are on
 * a boundary; a boundary arm paired with an interior arm still understates the
 * variance and overstates significance. Substitute per arm.
 */
function boundarySubstitutionApplies(
  control: MetricArmEstimate,
  treatment: MetricArmEstimate,
  absoluteLift: number | null,
  samplingVar: number | null,
): boolean {
  return (
    samplingVar !== null &&
    absoluteLift !== null &&
    absoluteLift !== 0 &&
    control.metric_type === "binomial" &&
    treatment.metric_type === "binomial" &&
    (control.sampling_var === 0 || treatment.sampling_var === 0)
  );
}

function boundarySafeArmSamplingVar(arm: MetricArmEstimate): number {
  return arm.sampling_var === null || arm.sampling_var === 0
    ? agrestiCaffoSamplingVar(arm)
    : arm.sampling_var;
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
    relativeLift === 0 ||
    control.metric_type !== "binomial" ||
    treatment.metric_type !== "binomial" ||
    control.point_estimate === null ||
    treatment.point_estimate === null ||
    control.sampling_var === null ||
    treatment.sampling_var === null ||
    (control.sampling_var !== 0 && treatment.sampling_var !== 0)
  ) {
    return samplingVar;
  }

  const controlSamplingVar = boundarySafeArmSamplingVar(control);
  const treatmentSamplingVar = boundarySafeArmSamplingVar(treatment);

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
