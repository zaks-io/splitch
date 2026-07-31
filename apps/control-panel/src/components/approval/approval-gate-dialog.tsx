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
 * Refusals the Worker answers by resolving the Approval Request terminally
 * rather than leaving it pending. After one of these the proposal is a closed
 * record, so the gate must stop offering to apply it and must stop describing it
 * as still pending — the copy would otherwise report a state the audit log is
 * not in.
 */
const TERMINALLY_RESOLVING = new Set([
  "RUN_FROZEN",
  "APPROVAL_REQUEST_STALE",
  "APPROVAL_REQUEST_RESOLVED",
]);

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

        <ApprovalGateBody
          confirming={confirming}
          error={error}
          onCancel={onCancel}
          onConfirm={onConfirm}
          request={request}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Everything the refusal changes, split from the portalled shell so it can be
 * rendered — and asserted — on its own. `DialogContent` renders through a portal
 * that produces nothing server-side, which would leave the copy and the confirm
 * control untestable without a browser.
 */
export function ApprovalGateBody({
  request,
  confirming,
  error,
  onCancel,
  onConfirm,
}: {
  request: ApprovalGateRecord;
  confirming: boolean;
  error: MutationErrorSurface | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const disposition = gateDisposition(error);
  return (
    <>
      <div className="grid gap-5">
        <ApprovalPolicyNote policyContexts={request.policyContexts} />
        <ApprovalDiffTable rows={request.rows} />
        {error ? <ApprovalRefusalNotice error={error} /> : null}
        <p className="text-muted-foreground text-xs leading-5" data-gate-disposition={disposition}>
          <GateFooterCopy disposition={disposition} requestId={request.id} />
        </p>
      </div>

      <DialogFooter>
        <Button disabled={confirming} onClick={onCancel} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          data-approval-confirm="true"
          disabled={confirming || disposition !== "pending"}
          onClick={onConfirm}
          type="button"
        >
          {confirming ? "Applying…" : "Confirm and apply"}
        </Button>
      </DialogFooter>
    </>
  );
}

type GateDisposition = "pending" | "resolved" | "applied";

/**
 * A Request another reviewer already APPLIED is not a refused proposal. It is
 * closed because the change landed, so the remedy is to go look at it — telling
 * the operator to propose it again would have them write the change twice, and
 * would contradict the refusal notice directly above.
 */
function gateDisposition(error: MutationErrorSurface | null): GateDisposition {
  if (error === null) return "pending";
  if (error.kind === "resolved" && error.status === "applied") return "applied";
  return TERMINALLY_RESOLVING.has(error.code) ? "resolved" : "pending";
}

function GateFooterCopy({
  disposition,
  requestId,
}: {
  disposition: GateDisposition;
  requestId: string;
}) {
  if (disposition === "applied") {
    return (
      <>
        Approval Request <span className="font-mono">{requestId}</span> was already applied by
        another Review, so this gate has nothing left to do. Re-read the Flag to see the change that
        landed before proposing anything else.
      </>
    );
  }
  if (disposition === "resolved") {
    return (
      <>
        The refusal above resolved Approval Request <span className="font-mono">{requestId}</span>,
        so it can no longer be applied. The record and the reason stay in the audit log; propose the
        change again once the refusal is cleared.
      </>
    );
  }
  return (
    <>
      Confirming records your Review on Approval Request{" "}
      <span className="font-mono">{requestId}</span> and applies it. Cancelling leaves the proposal
      pending in the audit log; it is not deleted.
    </>
  );
}
