import type { ConcludeRunRequest, ErrorResponse } from "@splitch/contracts";
import { useRef, useState } from "react";
import type { ApprovalGateRecord } from "#lib/approval/approval-gate-record";
import { controlPlaneErrorMessage } from "#lib/shared/control-plane-error-message";
import { concludeControlPanelRun } from "./control-plane-conclusion-functions";
import {
  type ConclusionDraft,
  type ConclusionScope,
  type ConclusionTarget,
  conclusionDraft,
  conclusionRequest,
} from "./experiment-conclusion-model";
import { useExperimentDetailRefresh } from "./use-experiment-detail-refresh";

const PRECOMMIT_REFUSALS = new Set([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "DECISION_BLOCKED",
  "DECISION_RESULT_STALE",
  "DECISION_RESULT_UNAVAILABLE",
  "TARGET_CONFIGURATION_STALE",
  "RUN_NOT_FOUND",
  "RUN_NOT_RUNNING",
  "EXPERIMENT_NOT_FOUND",
  "FLAG_NOT_FOUND",
  "ENVIRONMENT_NOT_FOUND",
  "RUN_FROZEN",
  "VARIANT_NOT_AVAILABLE",
]);

export interface ConclusionFormOptions {
  scope: ConclusionScope;
  target: ConclusionTarget;
  expectedResultToken: string;
  dataWatermark: string;
  onClose: () => void;
  onLock: (locked: boolean) => void;
}

export function useExperimentConclusion({
  scope,
  target,
  expectedResultToken,
  dataWatermark,
  onClose,
  onLock,
}: ConclusionFormOptions) {
  const [draft, setDraft] = useState(() => conclusionDraft(target));
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [attempt, setAttempt] = useState<ConcludeRunRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string>();
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [approval, setApproval] = useState<ApprovalGateRecord>();
  const [pendingApprovalId, setPendingApprovalId] = useState<string>();
  const refresh = useExperimentDetailRefresh(scope, scope.experimentId);
  const parsed = conclusionRequest({
    draft,
    target,
    expectedResultToken,
    dataWatermark,
    idempotencyKey,
  });

  const proposedRequest = parsed.ok ? parsed.request : null;

  function update(patch: Partial<ConclusionDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setIdempotencyKey(crypto.randomUUID());
    setError(undefined);
  }

  async function submit() {
    if (submitting.current) return;
    const request = attempt ?? proposedRequest;
    if (!request) return;
    submitting.current = true;
    setAttempt(request);
    setBusy(true);
    onLock(true);
    setError(undefined);
    try {
      const { flagId: _flagId, ...runScope } = scope;
      const result = await concludeControlPanelRun({ data: { ...runScope, ...request } });
      if (result.ok) accept(result.data.approvalRequest);
      else refuse(result.error);
    } catch {
      setError("The conclusion status could not be confirmed. Retry to recover the same decision.");
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }

  async function close() {
    try {
      await refresh();
      onClose();
    } catch {
      setError("The Results page could not refresh. Retry refreshing to read the current Run.");
    }
  }

  function accept(request: ApprovalGateRecord) {
    setApproval(request);
    const recoveryId = conclusionRecoveryApprovalId(request);
    if (recoveryId) setPendingApprovalId(recoveryId);
  }

  function refuse(failure: ErrorResponse) {
    setError(controlPlaneErrorMessage(failure));
    if (failure.code === "DECISION_RESULT_STALE" || failure.code === "TARGET_CONFIGURATION_STALE") {
      setRefreshRequired(true);
    }
    const details = failure.details;
    if ("approvalRequestId" in details && typeof details.approvalRequestId === "string") {
      setPendingApprovalId(details.approvalRequestId);
      return;
    }
    if (PRECOMMIT_REFUSALS.has(failure.code)) {
      setAttempt(null);
      onLock(false);
    }
  }
  const locked = busy || attempt !== null;
  const fieldsDisabled = locked || refreshRequired;
  const invalid = refreshRequired || (!attempt && !parsed.ok);
  const submitDisabled = busy || invalid;
  const validationMessage = !parsed.ok && draft.selectedVariant ? parsed.message : null;
  return {
    locked,
    fieldsDisabled,
    invalid,
    submitDisabled,
    validationMessage,
    refreshRequired,
    draft,
    attempt,
    busy,
    error,
    approval,
    pendingApprovalId,
    parsed,
    update,
    submit,
    close,
  };
}

export function conclusionRecoveryApprovalId(
  request: Pick<ApprovalGateRecord, "id" | "status">,
): string | undefined {
  return request.status === "pending" || request.status === "stale" ? request.id : undefined;
}
