import type { FlagEditing } from "#lib/use-flag-editing";
import { ApprovalGateDialog } from "./approval/approval-gate-dialog";
import { ApprovalRecordNote } from "./approval/approval-record-note";
import { ApprovalRefusalNotice } from "./approval/approval-refusal-notice";

/**
 * The single place the Flag detail screen reports what the Worker said.
 *
 * One outcome region for every control on the screen, because there is one write
 * path: an ungated apply, a gated confirm, or a structured refusal. Per-control
 * error slots would let two controls disagree about the state of one Flag.
 */
export function FlagEditOutcome({ editing }: { editing: FlagEditing }) {
  const state = editing.state;

  if (state.phase === "gate") {
    return (
      <ApprovalGateDialog
        confirming={state.confirming}
        error={state.error}
        onCancel={editing.dismiss}
        onConfirm={() => void editing.confirm()}
        request={state.request}
        summary={state.intent.summary}
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
      <p className="text-muted-foreground text-sm leading-6" data-flag-edit-applied="ungated">
        Saved. This Environment's Policy does not gate this change, so no Approval Request was
        needed.
      </p>
    );
  }

  return null;
}
