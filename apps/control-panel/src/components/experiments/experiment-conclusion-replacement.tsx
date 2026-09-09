import type { ErrorResponse } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { useRef, useState } from "react";
import {
  loadControlPanelConclusionTarget,
  replaceControlPanelConclusionPromotion,
} from "#lib/experiments/control-plane-conclusion-functions";
import type {
  ConclusionScope,
  ConclusionTarget,
} from "#lib/experiments/experiment-conclusion-model";
import { controlPlaneErrorMessage } from "#lib/shared/control-plane-error-message";

export function ExperimentConclusionReplacement({
  scope,
  target,
  conclusionId,
  onLock,
  onReplaced,
}: {
  scope: ConclusionScope;
  target: ConclusionTarget;
  conclusionId: string;
  onLock: (locked: boolean) => void;
  onReplaced: (approvalRequestId: string) => void;
}) {
  const attempt = useRef<{ expectedConfigVersion: number; idempotencyKey: string } | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function replace() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    onLock(true);
    setError(undefined);
    try {
      const pinned = await replacementAttempt();
      if (!pinned) return;
      const { flagId: _flagId, ...runScope } = scope;
      const result = await replaceControlPanelConclusionPromotion({
        data: { ...runScope, conclusionId, ...pinned },
      });
      if (!result.ok) {
        refused(result.error);
        return;
      }
      onLock(false);
      onReplaced(result.data.approvalRequest.id);
    } catch {
      setError(
        "The Promotion request status could not be confirmed. Retry to recover the same request.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function refused(failure: ErrorResponse) {
    setError(controlPlaneErrorMessage(failure));
    if (failure.code === "TARGET_CONFIGURATION_STALE") attempt.current = null;
    onLock(false);
  }

  async function replacementAttempt() {
    if (attempt.current) return attempt.current;
    const current = await loadControlPanelConclusionTarget({
      data: {
        appId: scope.appId,
        environmentId: target.environmentId,
        flagId: target.flagId,
      },
    });
    if (!current.ok) {
      setError(controlPlaneErrorMessage(current.error));
      onLock(false);
      return null;
    }
    attempt.current = {
      expectedConfigVersion: current.data.version,
      idempotencyKey: crypto.randomUUID(),
    };
    return attempt.current;
  }

  return (
    <>
      <Alert>
        <AlertTitle>Target configuration changed</AlertTitle>
        <AlertDescription>
          Request Promotion again to review the saved configuration against the current target. The
          conclusion remains unchanged.
        </AlertDescription>
      </Alert>
      {error ? <p role="alert">{error}</p> : null}
      <Button disabled={busy} onClick={() => void replace()}>
        {busy ? "Requesting…" : "Request Promotion again"}
      </Button>
    </>
  );
}
