import { Button } from "@splitch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import type { MutationErrorSurface } from "#lib/api";
import type { ApprovalGateRecord } from "#lib/approval-gate-record";
import { ApprovalDiffTable } from "./approval-diff-table";
import { ApprovalPolicyNote } from "./approval-policy-note";
import { ApprovalRefusalNotice } from "./approval-refusal-notice";

/**
 * The confirmation gate for a Policy-gated change.
 *
 * It takes a pending Approval Request and a confirm/cancel pair, and nothing
 * else. It does not know what a Flag is, does not compute the diff, and does not
 * read the Environment Policy — all three arrive on the record the Worker wrote.
 * That is what makes it reusable for promotion between Environments (SPL-122):
 * a different proposal, the same record shape, the same gate.
 */
export function ApprovalGateDialog({
  request,
  summary,
  confirming,
  error,
  onCancel,
  onConfirm,
}: {
  request: ApprovalGateRecord;
  /** What the operator asked for, in their words, above the Worker's diff. */
  summary: string;
  confirming: boolean;
  error: MutationErrorSurface | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        data-approval-gate={request.id}
      >
        <DialogHeader>
          <DialogTitle>Confirm this change</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <ApprovalPolicyNote policyContexts={request.policyContexts} />
          <ApprovalDiffTable rows={request.rows} />
          {error ? <ApprovalRefusalNotice error={error} /> : null}
          <p className="text-muted-foreground text-xs leading-5">
            Confirming records your Review on Approval Request{" "}
            <span className="font-mono">{request.id}</span> and applies it. Cancelling leaves the
            proposal pending in the audit log; it is not deleted.
          </p>
        </div>

        <DialogFooter>
          <Button disabled={confirming} onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            data-approval-confirm="true"
            disabled={confirming}
            onClick={onConfirm}
            type="button"
          >
            {confirming ? "Applying…" : "Confirm and apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
