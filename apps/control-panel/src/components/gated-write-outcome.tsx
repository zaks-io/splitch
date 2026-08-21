import type { GatedWritePhase } from "#lib/gated-write-phase";
import { ApprovalGateDialog } from "./approval/approval-gate-dialog";
import { ApprovalRecordNote } from "./approval/approval-record-note";
import { ApprovalRefusalNotice } from "./approval/approval-refusal-notice";

/**
 * The single place a screen reports what the Worker said about a Policy-gated
 * write.
 *
 * One outcome region per write controller: an ungated apply, a gated confirm, or
 * a structured refusal. Detail and Promotion each have one controller; the App
 * matrix has one Environment-pinned controller per cell.
 *
 * Every consumer reaches the same three states, so they render through this component rather than
 * separate copies that could drift on what a refusal or a pending record looks like.
 */
export type GatedWrite = {
  readonly state: GatedWritePhase;
  confirm(): Promise<void>;
  dismiss(): void;
};

export function GatedWriteOutcome({
  write,
  ungatedCopy,
}: {
  write: GatedWrite;
  /** What an ungated apply means on this screen, in that screen's own words. */
  ungatedCopy: string;
}) {
  const state = write.state;

  if (state.phase === "gate") {
    return (
      <ApprovalGateDialog
        confirming={state.confirming}
        error={state.error}
        onCancel={write.dismiss}
        onConfirm={() => void write.confirm()}
        request={state.request}
        summary={state.summary}
      />
    );
  }

  if (state.phase === "refused") {
    return <ApprovalRefusalNotice error={state.error} />;
  }

  // An ungated apply carries no Approval Request, and saying so is the honest
  // report: nothing was gated, so nothing was recorded for review.
  if (state.phase === "applied") {
    return state.approvalRequest ? (
      <ApprovalRecordNote request={state.approvalRequest} />
    ) : (
      <p className="text-muted-foreground text-sm leading-6" data-gated-write-applied="ungated">
        {ungatedCopy}
      </p>
    );
  }

  return null;
}
