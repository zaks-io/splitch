import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker";
import {
  activationRowsAt,
  exposureOnDay,
  exposuresOnDay,
  exposuresOnDayWithIngest,
  SRM_TEST_RUN_ID,
} from "./srm-checker-test-helpers";

const RUN_ID = SRM_TEST_RUN_ID;

describe("SRMChecker late-ingestion alarm persistence", () => {
  it("keeps the Exposure SRM alarm when late-ingested Treatments have earlier event times", () => {
    // PR #651 review: 900/100 fires (p ~ 2e-215). Adding 800 late Treatment
    // Exposures with earlier event timestamps but later ingest times must not
    // rewrite the path or erase the alarm (event-time order would yield p~0.264).
    const earlyEvent = "2026-07-01T08:00:00.000Z";
    const earlierEvent = "2026-07-01T06:00:00.000Z";
    const earlyIngest = "2026-07-01T12:00:00.000Z";
    const lateIngest = "2026-07-02T12:00:00.000Z";

    const earlyOnly = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDayWithIngest("control", 900, earlyEvent, earlyIngest),
        ...exposuresOnDayWithIngest("treatment", 100, earlyEvent, earlyIngest),
      ],
      srm_procedure: "sequential_martingale",
    });
    const afterLateIngest = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDayWithIngest("control", 900, earlyEvent, earlyIngest),
        ...exposuresOnDayWithIngest("treatment", 100, earlyEvent, earlyIngest),
        ...exposuresOnDayWithIngest("treatment", 800, earlierEvent, lateIngest, 100),
      ],
      srm_procedure: "sequential_martingale",
    });

    expect(earlyOnly.srm.srm_is_mismatch).toBe(true);
    expect(earlyOnly.srm.srm_p_value).toBeLessThan(1e-100);
    expect(afterLateIngest.srm.observed_counts).toEqual({ control: 900, treatment: 900 });
    expect(afterLateIngest.srm.srm_is_mismatch).toBe(true);
    expect(afterLateIngest.srm.srm_p_value).toBe(earlyOnly.srm.srm_p_value);
  });

  it("keeps activated SRM alarm when late-ingested Activations have earlier event times", () => {
    const exposureTs = "2026-07-01T00:00:00.000Z";
    const earlyActivationEvent = "2026-07-01T08:00:00.000Z";
    const earlierActivationEvent = "2026-07-01T06:00:00.000Z";
    const earlyIngest = "2026-07-01T12:00:00.000Z";
    const lateIngest = "2026-07-02T12:00:00.000Z";
    const control = exposuresOnDay("control", 900, exposureTs);
    const treatmentEarly = exposuresOnDay("treatment", 100, exposureTs);
    const treatmentLate = exposuresOnDay("treatment", 800, exposureTs, 100);

    const earlyOnly = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatmentEarly],
      activation_rows: [
        ...activationRowsAt(control, earlyActivationEvent, earlyIngest),
        ...activationRowsAt(treatmentEarly, earlyActivationEvent, earlyIngest),
      ],
      srm_procedure: "sequential_martingale",
    });
    const afterLateIngest = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatmentEarly, ...treatmentLate],
      activation_rows: [
        ...activationRowsAt(control, earlyActivationEvent, earlyIngest),
        ...activationRowsAt(treatmentEarly, earlyActivationEvent, earlyIngest),
        ...activationRowsAt(treatmentLate, earlierActivationEvent, lateIngest),
      ],
      srm_procedure: "sequential_martingale",
    });

    expect(earlyOnly.srm.activated_srm_mismatch).toBe(true);
    expect(earlyOnly.srm.activated_srm_p_value).toBeLessThan(1e-100);
    expect(afterLateIngest.srm.activated_srm_mismatch).toBe(true);
    expect(afterLateIngest.srm.activated_srm_p_value).toBe(earlyOnly.srm.activated_srm_p_value);
  });
});

describe("SRMChecker eligibility-clock alarm persistence", () => {
  it("keeps activated SRM alarm when Activations were ingested before their Exposures", () => {
    // Codex review: Activation-before-Exposure ingest must append at eligibility
    // time (max of both ingest clocks), not insert into an earlier path prefix.
    const exposureEvent = "2026-07-01T00:00:00.000Z";
    const activationEvent = "2026-07-01T08:00:00.000Z";
    const earlyIngest = "2026-07-01T12:00:00.000Z";
    const lateExposureIngest = "2026-07-02T12:00:00.000Z";
    const earlyActivationIngest = "2026-07-01T06:00:00.000Z";
    const control = exposuresOnDayWithIngest("control", 900, exposureEvent, earlyIngest);
    const treatmentEarly = exposuresOnDayWithIngest("treatment", 100, exposureEvent, earlyIngest);
    const treatmentLate = exposuresOnDayWithIngest(
      "treatment",
      800,
      exposureEvent,
      lateExposureIngest,
      100,
    );

    const earlyOnly = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatmentEarly],
      activation_rows: [
        ...activationRowsAt(control, activationEvent, earlyIngest),
        ...activationRowsAt(treatmentEarly, activationEvent, earlyIngest),
      ],
      srm_procedure: "sequential_martingale",
    });
    const afterLateExposure = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatmentEarly, ...treatmentLate],
      activation_rows: [
        ...activationRowsAt(control, activationEvent, earlyIngest),
        ...activationRowsAt(treatmentEarly, activationEvent, earlyIngest),
        // Activations landed before the Exposures; eligibility is the late Exposure ingest.
        ...activationRowsAt(treatmentLate, activationEvent, earlyActivationIngest),
      ],
      srm_procedure: "sequential_martingale",
    });

    expect(earlyOnly.srm.activated_srm_mismatch).toBe(true);
    expect(earlyOnly.srm.activated_srm_p_value).toBeLessThan(1e-100);
    expect(afterLateExposure.srm.activated_srm_mismatch).toBe(true);
    expect(afterLateExposure.srm.activated_srm_p_value).toBe(earlyOnly.srm.activated_srm_p_value);
  });

  it("keeps activated SRM alarm when a late earlier Exposure newly qualifies Activations", () => {
    // Codex review: Exposure at 10:00/11:00 + Activation at 09:00/12:00 is not
    // qualifying. A duplicate Exposure at 08:00 ingested 20:00 makes the
    // Activation valid; eligibility must be max(20:00, 12:00)=20:00, not
    // max(first_ingest=11:00, 12:00)=12:00 which back-dates into the alarm prefix.
    const laterExposureEvent = "2026-07-01T10:00:00.000Z";
    const earlierExposureEvent = "2026-07-01T08:00:00.000Z";
    const activationEvent = "2026-07-01T09:00:00.000Z";
    const earlyExposureIngest = "2026-07-01T11:00:00.000Z";
    const activationIngest = "2026-07-01T12:00:00.000Z";
    const lateEarlierExposureIngest = "2026-07-01T20:00:00.000Z";
    const control = exposuresOnDayWithIngest(
      "control",
      45,
      earlierExposureEvent,
      earlyExposureIngest,
    );
    const treatmentLaterExposure = exposuresOnDayWithIngest(
      "treatment",
      45,
      laterExposureEvent,
      earlyExposureIngest,
    );
    const treatmentEarlierExposure = exposuresOnDayWithIngest(
      "treatment",
      45,
      earlierExposureEvent,
      lateEarlierExposureIngest,
    );

    const beforeLateEarlier = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatmentLaterExposure],
      activation_rows: [
        ...activationRowsAt(control, activationEvent, activationIngest),
        // Pre-Exposure relative to the only known Exposure (10:00); not activated.
      ],
      srm_procedure: "sequential_martingale",
    });
    const afterLateEarlier = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      // Raw-like duplicates: later Exposure (10:00/11:00) plus late earlier (08:00/20:00).
      exposures: [...control, ...treatmentLaterExposure, ...treatmentEarlierExposure],
      activation_rows: [
        ...activationRowsAt(control, activationEvent, activationIngest),
        ...activationRowsAt(treatmentLaterExposure, activationEvent, activationIngest),
      ],
      srm_procedure: "sequential_martingale",
    });

    expect(beforeLateEarlier.srm.activated_srm_mismatch).toBe(true);
    expect(beforeLateEarlier.srm.activated_srm_p_value).toBeLessThan(0.001);
    expect(afterLateEarlier.health.activation_rates).toMatchObject({
      control: 1,
      treatment: 1,
    });
    // Sticky anytime p: back-dating eligibility to 12:00 would insert 45 Treatments
    // into the Control-only prefix and clear the alarm (p→1).
    expect(afterLateEarlier.srm.activated_srm_mismatch).toBe(true);
    expect(afterLateEarlier.srm.activated_srm_p_value).toBe(
      beforeLateEarlier.srm.activated_srm_p_value,
    );
  });

  it("keeps the Exposure SRM alarm when a late conflict removes one Entity", () => {
    const earlyEvent = "2026-07-01T08:00:00.000Z";
    const earlyIngest = "2026-07-01T12:00:00.000Z";
    const conflictIngest = "2026-07-02T12:00:00.000Z";
    const earlyOnly = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDayWithIngest("control", 900, earlyEvent, earlyIngest),
        ...exposuresOnDayWithIngest("treatment", 100, earlyEvent, earlyIngest),
      ],
      srm_procedure: "sequential_martingale",
    });
    const afterConflict = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDayWithIngest("control", 899, earlyEvent, earlyIngest),
        // One early Control Entity is removed by a late conflict; survivors keep
        // first_ingest_ts so the sticky early mismatch still holds.
        exposureOnDay("__multiple__", "control_899", earlyEvent, conflictIngest),
        ...exposuresOnDayWithIngest("treatment", 100, earlyEvent, earlyIngest),
      ],
      srm_procedure: "sequential_martingale",
    });

    expect(earlyOnly.srm.srm_is_mismatch).toBe(true);
    expect(earlyOnly.srm.srm_p_value).toBeLessThan(1e-100);
    expect(afterConflict.srm.observed_counts).toEqual({ control: 899, treatment: 100 });
    expect(afterConflict.health.multiple_count).toBe(1);
    expect(afterConflict.srm.srm_is_mismatch).toBe(true);
    expect(afterConflict.srm.srm_p_value).toBeLessThan(1e-100);
  });
});
