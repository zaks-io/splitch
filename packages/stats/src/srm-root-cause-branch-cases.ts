import type { SrmRootCauseBranch, SrmRootCauseInput } from "./srm-root-cause-types";
import { SRM_ROOT_CAUSE_NEXT_CHECK } from "./srm-root-cause-types";

export function srmRootCauseBranchCases(): Array<{
  name: string;
  input: SrmRootCauseInput;
  expectedBranch: SrmRootCauseBranch | null;
  nextCheck?: string;
}> {
  return [
    {
      name: "no SRM fired",
      input: { exposureMismatch: false, activatedMismatch: false, activationCount: null },
      expectedBranch: null,
    },
    {
      name: "no SRM and no activation gate",
      input: { exposureMismatch: false, activatedMismatch: null, activationCount: null },
      expectedBranch: null,
    },
    {
      name: "triggered_only when activated fires with Activations and Exposure is clean",
      input: { exposureMismatch: false, activatedMismatch: true, activationCount: 400 },
      expectedBranch: "triggered_only",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when activated mismatch is the zero-Activation sentinel",
      input: { exposureMismatch: false, activatedMismatch: true, activationCount: 0 },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "segment_localized when a proper subset mismatches and proportions differ",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        activationCount: null,
        segmentCuts: [
          {
            dimensionId: "country",
            dimensionValue: "US",
            srmIsMismatch: true,
            observedCounts: { control: 7000, treatment: 3000 },
          },
          {
            dimensionId: "country",
            dimensionValue: "DE",
            srmIsMismatch: false,
            observedCounts: { control: 50, treatment: 50 },
          },
          {
            dimensionId: "country",
            dimensionValue: "FR",
            srmIsMismatch: false,
            observedCounts: { control: 50, treatment: 50 },
          },
        ],
      },
      expectedBranch: "segment_localized",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified for unequal-volume identical 60/40 proportions across slices",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        activationCount: null,
        segmentCuts: [
          {
            dimensionId: "country",
            dimensionValue: "US",
            srmIsMismatch: true,
            observedCounts: { control: 6000, treatment: 4000 },
          },
          {
            dimensionId: "country",
            dimensionValue: "DE",
            srmIsMismatch: false,
            observedCounts: { control: 60, treatment: 40 },
          },
        ],
      },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "day_one when only the first Exposure day mismatches",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        activationCount: null,
        dayBuckets: [
          { day: "2026-07-01", srmIsMismatch: true },
          { day: "2026-07-02", srmIsMismatch: false },
          { day: "2026-07-03", srmIsMismatch: false },
        ],
      },
      expectedBranch: "day_one",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when Exposure fires without localizing signals",
      input: { exposureMismatch: true, activatedMismatch: false, activationCount: null },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when every segment cut mismatches",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        activationCount: null,
        segmentCuts: [
          {
            dimensionId: "country",
            dimensionValue: "US",
            srmIsMismatch: true,
            observedCounts: { control: 7000, treatment: 3000 },
          },
          {
            dimensionId: "country",
            dimensionValue: "DE",
            srmIsMismatch: true,
            observedCounts: { control: 70, treatment: 30 },
          },
        ],
      },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when day-one and a later day both mismatch",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        activationCount: null,
        dayBuckets: [
          { day: "2026-07-01", srmIsMismatch: true },
          { day: "2026-07-02", srmIsMismatch: true },
        ],
      },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified for a singleton mismatching day (no later scored day)",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        activationCount: null,
        dayBuckets: [{ day: "2026-07-01", srmIsMismatch: true }],
      },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when both Exposure and activated SRM fire without slices",
      input: { exposureMismatch: true, activatedMismatch: true, activationCount: 400 },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
  ];
}
