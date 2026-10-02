import type { CupedAttributeSource, CupedCovariateSource } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyCupedAdjustment } from "./cuped";
import type { CupedCovariateRow, EntityAggregate } from "./variance-estimator-types";

const METRIC_ID = "count_metric";

describe("CUPED attribute selection ranking", () => {
  it("prefers a declared attribute over a historical one even when history covers more Entities", () => {
    const result = adjust({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      covariates: [
        ...attributeRows("historical_wide", ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"], {
          source: "historical_selected",
          covariateSource: "historical_attribute",
          values: [0, 1, 2, 3, 0, 1, 2, 3],
        }),
        ...attributeRows("declared_narrow", ["c0", "c1", "c2", "t0", "t1", "t2"], {
          source: "declared",
          covariateSource: "declared_attribute",
          values: [0, 1, 2, 0, 1, 2],
        }),
      ],
    });

    expect(result.method).toBe("attribute_covariate");
    expect(result.attribute).toBe("declared_narrow");
    expect(result.attributeSource).toBe("declared");
  });

  it("prefers pre_period_selected over historical_selected at equal coverage", () => {
    const result = adjust({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      covariates: [
        ...attributeRows("zeta_hist", ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"], {
          source: "historical_selected",
          covariateSource: "historical_attribute",
          values: [8, 7, 6, 5, 4, 3, 2, 1],
        }),
        ...attributeRows("alpha_pre", ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"], {
          source: "pre_period_selected",
          covariateSource: "historical_attribute",
          values: [1, 2, 3, 4, 5, 6, 7, 8],
        }),
      ],
    });

    expect(result.attribute).toBe("alpha_pre");
    expect(result.attributeSource).toBe("pre_period_selected");
  });

  it("prefers the same-source attribute with higher min-arm coverage", () => {
    const result = adjust({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      covariates: [
        ...attributeRows("full", ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"], {
          source: "historical_selected",
          covariateSource: "historical_attribute",
          values: [0, 1, 2, 3, 0, 1, 2, 3],
        }),
        ...attributeRows("partial", ["c0", "c1", "c2", "t0", "t1", "t2"], {
          source: "historical_selected",
          covariateSource: "historical_attribute",
          values: [3, 2, 1, 3, 2, 1],
        }),
      ],
    });

    expect(result.attribute).toBe("full");
    expect(result.coveragePct).toBe(100);
  });

  it("breaks remaining ties with lexicographic attribute name", () => {
    const result = adjust({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      covariates: [
        ...attributeRows("zeta", ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"], {
          source: "historical_selected",
          covariateSource: "historical_attribute",
          values: [0, 1, 2, 3, 0, 1, 2, 3],
        }),
        ...attributeRows("alpha", ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"], {
          source: "historical_selected",
          covariateSource: "historical_attribute",
          values: [3, 2, 1, 0, 3, 2, 1, 0],
        }),
      ],
    });

    expect(result.attribute).toBe("alpha");
  });
});

describe("CUPED missing, singular, low-sample, and no-covariate fallbacks", () => {
  it("reports none when covariate coverage is below the threshold", () => {
    const result = adjust({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      covariates: [
        ...attributeRows("sparse", ["c0", "t0"], {
          source: "historical_selected",
          covariateSource: "historical_attribute",
          values: [1, 2],
        }),
      ],
    });

    expect(result.method).toBe("none");
    expect(result.attribute).toBeNull();
    expect(result.coveragePct).toBe(0);
  });

  it("reports none for a singular covariate that never varies within an arm", () => {
    const result = adjust({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      covariates: [
        ...attributeRows("constant", ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"], {
          source: "historical_selected",
          covariateSource: "historical_attribute",
          values: [5, 5, 5, 5, 5, 5, 5, 5],
        }),
      ],
    });

    expect(result.method).toBe("none");
    expect(result.attribute).toBeNull();
  });

  it("selects the same covariate whatever its units", () => {
    const ids = ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"];
    const values = [0, 1, 2, 3, 0, 1, 2, 3];
    const selected = (scale: number) =>
      adjust({
        controlValues: [10, 12, 14, 16],
        treatmentValues: [11, 13, 15, 17],
        covariates: attributeRows("scaled", ids, {
          source: "declared",
          covariateSource: "declared_attribute",
          values: values.map((value) => value * scale),
        }),
      }).attribute;

    expect(selected(1)).toBe("scaled");
    expect(selected(1e-7)).toBe("scaled");
  });

  it("rejects an attribute whose rows disagree on provenance, in either row order", () => {
    const declared = attributeRows("mixed", ["c0", "c1"], {
      source: "declared",
      covariateSource: "declared_attribute",
      values: [1, 2],
    });
    const historical = attributeRows("mixed", ["t0", "t1"], {
      source: "historical_selected",
      covariateSource: "historical_attribute",
      values: [3, 4],
    });
    const run = (covariates: readonly CupedCovariateRow[]) => () =>
      adjust({ controlValues: [10, 12], treatmentValues: [11, 13], covariates });

    expect(run([...declared, ...historical])).toThrow(/conflicting attribute_source/);
    expect(run([...historical, ...declared])).toThrow(/conflicting attribute_source/);
  });

  it("reports none when every arm has fewer than two covered Entities", () => {
    const result = adjust({
      controlValues: [10],
      treatmentValues: [20],
      covariates: [
        ...attributeRows("tiny", ["c0", "t0"], {
          source: "declared",
          covariateSource: "declared_attribute",
          values: [1, 9],
        }),
      ],
      coverageThresholdPct: 50,
    });

    expect(result.method).toBe("none");
    expect(result.coveragePct).toBe(0);
  });

  it("reports none when no locked covariate exists", () => {
    const result = adjust({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      covariates: [],
    });

    expect(result.method).toBe("none");
    expect(result.attribute).toBeNull();
    expect(result.attributeSource).toBeNull();
    expect(result.coveragePct).toBe(0);
  });

  it("skips a singular pre-period series and uses a fit-capable attribute instead", () => {
    const result = adjust({
      controlValues: [10, 12, 14, 16],
      treatmentValues: [11, 13, 15, 17],
      covariates: [
        ...prePeriodRows(
          ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"],
          [1, 1, 1, 1, 1, 1, 1, 1],
        ),
        ...attributeRows("signup_cohort", ["c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3"], {
          source: "historical_selected",
          covariateSource: "historical_attribute",
          values: [0, 1, 2, 3, 0, 1, 2, 3],
        }),
      ],
    });

    expect(result.method).toBe("attribute_covariate");
    expect(result.attribute).toBe("signup_cohort");
  });
});

function adjust({
  controlValues,
  treatmentValues,
  covariates,
  coverageThresholdPct,
}: {
  controlValues: readonly number[];
  treatmentValues: readonly number[];
  covariates: readonly CupedCovariateRow[];
  coverageThresholdPct?: number;
}) {
  return applyCupedAdjustment(
    {
      run_id: "run_cuped_select",
      metric_id: METRIC_ID,
      metric_type: "count",
      control_variant: "control",
      exposures: [],
      metric_values: [],
      pre_period_covariates: covariates,
      cuped_coverage_threshold_pct: coverageThresholdPct,
    },
    [arm("c", controlValues), arm("t", treatmentValues)],
  );
}

function arm(prefix: string, values: readonly number[]): EntityAggregate[] {
  return values.map((value, index) => ({
    targeting_key_hash: `${prefix}${index}`,
    first_exposure_ts: "2026-07-01T00:00:00.000Z",
    window_anchor: "2026-07-01T00:00:00.000Z",
    value,
    num_value: value,
    denom_value: 1,
    cuped_adjusted: false,
  }));
}

function prePeriodRows(
  entityIds: readonly string[],
  values: readonly number[],
): CupedCovariateRow[] {
  return entityIds.map((targeting_key_hash, index) => ({
    targeting_key_hash,
    metric_id: METRIC_ID,
    pre_period_value: values[index] ?? 0,
    covariate_source: "pre_period",
  }));
}

function attributeRows(
  attribute: string,
  entityIds: readonly string[],
  options: {
    source: CupedAttributeSource;
    covariateSource: CupedCovariateSource;
    values: readonly number[];
  },
): CupedCovariateRow[] {
  return entityIds.map((targeting_key_hash, index) => ({
    targeting_key_hash,
    metric_id: attribute,
    attribute,
    pre_period_value: options.values[index] ?? 0,
    covariate_source: options.covariateSource,
    locked: true,
    attribute_source: options.source,
  }));
}
