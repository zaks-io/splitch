import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { DialogFooter } from "@splitch/ui/components/dialog";
import { Spinner } from "@splitch/ui/components/spinner";
import { ApprovalRecordNote } from "#components/approval/approval-record-note";
import {
  type ConclusionFormOptions,
  useExperimentConclusion,
} from "#lib/experiments/use-experiment-conclusion";
import { ExperimentConclusionFields } from "./experiment-conclusion-fields";
import { ExperimentConclusionRecovery } from "./experiment-conclusion-recovery";

export function ExperimentConclusionForm(
  options: ConclusionFormOptions & { targetEnv: string; variants: readonly string[] },
) {
  const { scope, target, targetEnv, variants } = options;
  const {
    draft,
    attempt,
    busy,
    error,
    approval,
    pendingApprovalId,
    locked,
    fieldsDisabled,
    submitDisabled,
    validationMessage,
    refreshRequired,
    update,
    submit,
    close,
  } = useExperimentConclusion(options);
  const copy = conclusionCopy(refreshRequired, targetEnv);
  if (pendingApprovalId) {
    return (
      <>
        <ExperimentConclusionRecovery
          scope={scope}
          approvalRequestId={pendingApprovalId}
          target={target}
          onClose={() => void close()}
        />
        {error ? <p role="alert">{error}</p> : null}
      </>
    );
  }
  if (approval) {
    return (
      <>
        <p role="status">Run concluded. Promotion {approval.status}.</p>
        <ApprovalRecordNote request={approval} />
        {error ? <p role="alert">{error}</p> : null}
        <DialogFooter>
          <Button onClick={() => void close()}>Done</Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ExperimentConclusionFields
        draft={draft}
        target={target}
        variants={variants}
        update={update}
        disabled={fieldsDisabled}
      />
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Conclusion needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : validationMessage ? (
        <p role="alert" className="text-destructive text-sm">
          {validationMessage}
        </p>
      ) : null}
      <p className="text-muted-foreground text-sm">{copy.description}</p>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={locked} onClick={() => void close()}>
          {copy.cancelLabel}
        </Button>
        <Button type="submit" disabled={submitDisabled}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          {submitLabel(busy, attempt !== null)}
        </Button>
      </DialogFooter>
    </form>
  );
}

function submitLabel(busy: boolean, retrying: boolean) {
  if (busy) return "Concluding…";
  return retrying ? "Retry conclusion" : "Confirm and apply";
}

function conclusionCopy(refreshRequired: boolean, targetEnv: string) {
  if (refreshRequired) {
    return {
      cancelLabel: "Refresh Results",
      description:
        "Refresh Results, then reopen Conclude Run to review the current evidence and target configuration.",
    };
  }
  return {
    cancelLabel: "Cancel",
    description: `Confirming Ends this Run and applies the configuration above to ${targetEnv}. If Promotion fails, the Run stays ended and its Approval Request remains available for Review.`,
  };
}
