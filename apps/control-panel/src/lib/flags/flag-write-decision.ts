import { type MutationErrorSurface, mutationErrorSurface } from "#lib/shared/api";
import type { ApprovalGateRecord } from "#lib/approval/approval-gate-record";
import type { FlagWriteResult } from "#lib/flags/control-plane-flag-mutations";

/**
 * What one Flag Configuration write means, decided in one place.
 *
 * Pure so the branching is testable without a router or a Worker: applied, gated,
 * or refused — and never a fourth silent outcome. A write that neither applied nor
 * produced a gate is a refusal the operator must see (ADR-0036).
 */
export type FlagWriteDecision =
  | { readonly kind: "applied"; readonly approvalRequest: ApprovalGateRecord | null }
  | { readonly kind: "gate"; readonly approvalRequestId: string }
  | { readonly kind: "refused"; readonly error: MutationErrorSurface };

export function flagWriteDecision(result: FlagWriteResult): FlagWriteDecision {
  if (result.ok) return { kind: "applied", approvalRequest: result.approvalRequest };
  const error = mutationErrorSurface(result);
  return error.kind === "approval"
    ? { kind: "gate", approvalRequestId: error.approvalRequestId }
    : { kind: "refused", error };
}
