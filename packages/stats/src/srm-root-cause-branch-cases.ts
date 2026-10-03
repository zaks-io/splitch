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
      name: "unclassified when Exposure fires without localizing signals",
      input: { exposureMismatch: true, activatedMismatch: false, activationCount: null },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when both Exposure and activated SRM fire",
      input: { exposureMismatch: true, activatedMismatch: true, activationCount: 400 },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
  ];
}
