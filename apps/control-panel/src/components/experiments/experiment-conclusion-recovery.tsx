import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { Spinner } from "@splitch/ui/components/spinner";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApprovalGateBody } from "#components/approval/approval-gate-dialog";
import { ApprovalRecordNote } from "#components/approval/approval-record-note";
import { loadControlPanelConclusionApproval } from "#lib/experiments/control-plane-conclusion-functions";
import type {
  ConclusionScope,
  ConclusionTarget,
} from "#lib/experiments/experiment-conclusion-model";
import { reviewControlPanelApprovalRequest } from "#lib/flags/control-plane-flag-mutations";
import { type MutationErrorSurface, mutationErrorSurface } from "#lib/shared/api";
import { ExperimentConclusionReplacement } from "./experiment-conclusion-replacement";

export function ExperimentConclusionRecovery({
  scope,
  approvalRequestId: initialApprovalRequestId,
  target,
  onClose,
}: {
  scope: ConclusionScope;
  approvalRequestId: string;
  target: ConclusionTarget;
  onClose: () => void;
}) {
  const [approvalRequestId, setApprovalRequestId] = useState(initialApprovalRequestId);
  const [busy, setBusy] = useState(false);
  const [replacementLocked, setReplacementLocked] = useState(false);
  const [error, setError] = useState<MutationErrorSurface | null>(null);
  const [reviewKey, setReviewKey] = useState(() => crypto.randomUUID());
  const variantLabels = Object.fromEntries(
    target.variants.map((variant) => [variant.id, variant.name]),
  );
  const approval = useQuery({
    queryKey: ["conclusion-approval", scope.appId, approvalRequestId],
    queryFn: async () => {
      const result = await loadControlPanelConclusionApproval({
        data: { appId: scope.appId, approvalRequestId, variantLabels },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
    refetchOnWindowFocus: false,
  });
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await reviewControlPanelApprovalRequest({
        data: {
          appId: scope.appId,
          approvalRequestId,
          action: "approve_and_apply",
          idempotencyKey: reviewKey,
          variantLabels,
        },
      });
      if (!result.ok) {
        setError(mutationErrorSurface(result));
        setReviewKey(crypto.randomUUID());
      }
      await approval.refetch();
    } catch {
      setError({
        kind: "form",
        code: "TRANSPORT_FAILURE",
        message: "The Review status could not be confirmed. Retry the same Review.",
        fields: [],
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Alert>
        <AlertTitle>Run concluded</AlertTitle>
        <AlertDescription>
          The decision is saved. Promotion has a separate Approval Request.
        </AlertDescription>
      </Alert>
      {approval.isPending ? (
        <Spinner aria-label="Loading Approval Request" />
      ) : approval.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Approval Request unavailable</AlertTitle>
          <AlertDescription>
            {approval.error.message}
            <Button onClick={() => void approval.refetch()}>Retry</Button>
          </AlertDescription>
        </Alert>
      ) : approval.data.request.status === "pending" ? (
        <ApprovalGateBody
          request={approval.data.request}
          confirming={busy}
          error={error}
          onCancel={onClose}
          onConfirm={() => void confirm()}
        />
      ) : (
        <>
          <ApprovalRecordNote request={approval.data.request} />
          {approval.data.request.status === "stale" ? (
            <ExperimentConclusionReplacement
              scope={scope}
              target={target}
              conclusionId={approval.data.conclusionId}
              onLock={setReplacementLocked}
              onReplaced={(id) => {
                setApprovalRequestId(id);
                setError(null);
                setReviewKey(crypto.randomUUID());
              }}
            />
          ) : null}
          <Button disabled={replacementLocked} onClick={onClose}>
            Done
          </Button>
        </>
      )}
    </>
  );
}
