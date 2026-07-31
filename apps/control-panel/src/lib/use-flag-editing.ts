import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { mutationErrorSurface } from "./api";
import {
  editControlPanelTargetingRules,
  loadControlPanelApprovalRequest,
  reviewControlPanelApprovalRequest,
  updateControlPanelFlagConfig,
} from "./control-plane-flag-mutations";
import type { FlagEditIntent } from "./flag-edit-intent";
import { type GatedWritePhase, gatedWritePhase } from "./gated-write-phase";
import { flagWriteDecision } from "./flag-write-decision";

/**
 * The one write path of the Flag detail screen.
 *
 * There are no optimistic updates here and no local mirror of the Configuration.
 * A mutation either returns 200 — and the loader is invalidated so the screen
 * re-reads the Worker's state — or it returns a structured refusal that is
 * rendered as-is. Nothing on this screen ever shows a value the Worker has not
 * confirmed (ADR-0023).
 *
 * A Policy-gated change comes back as APPROVAL_REVIEW_REQUIRED with the id of the
 * Approval Request the Worker just recorded. The gate is then rendered from THAT
 * record, so the operator confirms the proposal on file rather than a diff this
 * panel computed for itself.
 */

export type FlagEditScope = {
  appId: string;
  environmentId: string;
  flagId: string;
  /** Variant id -> name, so the gate can name what a Targeting Rule serves. */
  variantLabels: Readonly<Record<string, string>>;
};

export type FlagEditing = {
  readonly state: GatedWritePhase;
  readonly busy: boolean;
  submit(intent: FlagEditIntent): Promise<void>;
  confirm(): Promise<void>;
  dismiss(): void;
};

export function useFlagEditing(
  scope: FlagEditScope,
  newKey: () => string = defaultKey,
): FlagEditing {
  const router = useRouter();
  const [state, setState] = useState<GatedWritePhase>({ phase: "idle" });

  const submit = useCallback(
    async (intent: FlagEditIntent) => {
      setState({ phase: "saving" });
      const decision = flagWriteDecision(await sendIntent(scope, intent, newKey()));
      if (decision.kind === "applied") {
        await router.invalidate();
        setState({ phase: "applied", approvalRequest: decision.approvalRequest });
        return;
      }
      if (decision.kind === "refused") {
        setState({ phase: "refused", summary: intent.summary, error: decision.error });
        return;
      }
      const request = await loadControlPanelApprovalRequest({
        data: {
          appId: scope.appId,
          approvalRequestId: decision.approvalRequestId,
          variantLabels: { ...scope.variantLabels },
        },
      });
      // The gate cannot render a proposal it could not read. Falling back to a
      // generic "please try again" would hide a real pending record.
      setState(gatedWritePhase(intent.summary, request));
    },
    [newKey, router, scope],
  );

  const confirm = useCallback(async () => {
    if (state.phase !== "gate") return;
    const { request } = state;
    setState({ ...state, confirming: true, error: null });
    const reviewed = await reviewControlPanelApprovalRequest({
      data: {
        appId: scope.appId,
        approvalRequestId: request.id,
        action: "approve_and_apply",
        idempotencyKey: newKey(),
        variantLabels: { ...scope.variantLabels },
      },
    });
    if (!reviewed.ok) {
      setState({ ...state, confirming: false, error: mutationErrorSurface(reviewed) });
      return;
    }
    await router.invalidate();
    setState({ phase: "applied", approvalRequest: reviewed.data });
  }, [newKey, router, scope.appId, scope.variantLabels, state]);

  const dismiss = useCallback(() => setState({ phase: "idle" }), []);

  return {
    state,
    busy: state.phase === "saving" || (state.phase === "gate" && state.confirming),
    submit,
    confirm,
    dismiss,
  };
}

function sendIntent(scope: FlagEditScope, intent: FlagEditIntent, idempotencyKey: string) {
  const target = {
    appId: scope.appId,
    environmentId: scope.environmentId,
    flagId: scope.flagId,
    variantLabels: { ...scope.variantLabels },
    idempotencyKey,
  };
  if (intent.kind === "targeting") {
    return editControlPanelTargetingRules({ data: { ...target, edit: { ...intent.edit } } });
  }
  return updateControlPanelFlagConfig({
    data: {
      ...target,
      patch: {
        ...intent.patch,
        ...(intent.patch.availableVariantNames
          ? { availableVariantNames: [...intent.patch.availableVariantNames] }
          : {}),
      },
    },
  });
}

function defaultKey(): string {
  return crypto.randomUUID();
}
