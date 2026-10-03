import { describe, expect, it } from "vitest";
import { materializeRunCommitments } from "./results-run-commitments";

const validPreRegistration = {
  hypothesis: "Treatment raises conversion",
  primary_metric_id: "conversion",
  metrics: [
    {
      metric_id: "conversion",
      desirability: "higher_is_better",
      rope: { lower: -0.01, upper: 0.01, scale: "absolute" },
    },
  ],
  ship_rule: {
    required_margin: 0.02,
    margin_scale: "absolute",
    conflict_resolution: "primary_wins",
  },
  futility: "off",
};

function commitmentRow(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    analysis_version: "analysis-v1",
    target_n: 5000,
    target_n_source: "default",
    planned_duration_days: 7,
    planned_duration_override_reason: null,
    pre_registration: null,
    ...fields,
  };
}

describe("materializeRunCommitments pre_registration", () => {
  it("treats a recorded null as never registered", () => {
    const commitments = materializeRunCommitments(commitmentRow({ pre_registration: null }));
    expect(commitments.analysis_version_source).toBe("frozen");
    if (commitments.analysis_version_source !== "frozen") return;
    expect(commitments.pre_registration).toBeUndefined();
  });

  it("freezes a valid pre_registration JSON blob", () => {
    const commitments = materializeRunCommitments(
      commitmentRow({ pre_registration: JSON.stringify(validPreRegistration) }),
    );
    expect(commitments.analysis_version_source).toBe("frozen");
    if (commitments.analysis_version_source !== "frozen") return;
    expect(commitments.pre_registration).toEqual(validPreRegistration);
  });

  it("refuses a missing pre_registration column instead of reading it as never registered", () => {
    const { pre_registration: _omitted, ...withoutColumn } = commitmentRow();
    expect(() => materializeRunCommitments(withoutColumn)).toThrow(/omitted pre_registration/);
  });

  it("refuses an empty-string pre_registration instead of dropping the freeze", () => {
    expect(() => materializeRunCommitments(commitmentRow({ pre_registration: "" }))).toThrow(
      /pre_registration is empty/,
    );
  });

  it("refuses corrupted pre_registration JSON instead of dropping the freeze", () => {
    expect(() =>
      materializeRunCommitments(commitmentRow({ pre_registration: "{not-json" })),
    ).toThrow(/pre_registration is not valid JSON/);
  });

  it("refuses a pre_registration blob that fails schema instead of dropping the freeze", () => {
    expect(() =>
      materializeRunCommitments(
        commitmentRow({
          pre_registration: JSON.stringify({ ...validPreRegistration, hypothesis: "" }),
        }),
      ),
    ).toThrow(/pre_registration is invalid/);
  });
});
