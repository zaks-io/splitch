import { type MutationErrorSurface, mutationErrorSurface } from "./api";
import type { ApprovalGateRecord } from "./approval-gate-record";
import type { ApprovalReadResult } from "./control-plane-flag-mutations";
import type { FlagEditIntent } from "./flag-edit-intent";

/**
 * Every state the Flag detail write path can be in, and the pure transitions into
 * the ones a Worker response decides.
 *
 * The transitions live here rather than inline in the hook so they are reachable
 * without a router or a Worker binding. A branch that only exists inside a
 * `setState` call cannot be tested, and an untestable fail-loud branch is one
 * refactor away from becoming a silent one (ADR-0036).
 */
export type FlagEditPhase =
  | { readonly phase: "idle" }
  | { readonly phase: "saving" }
  | {
      readonly phase: "gate";
      readonly intent: FlagEditIntent;
      readonly request: ApprovalGateRecord;
      readonly confirming: boolean;
      readonly error: MutationErrorSurface | null;
    }
  | {
      readonly phase: "refused";
      readonly intent: FlagEditIntent;
      readonly error: MutationErrorSurface;
    }
  | { readonly phase: "applied"; readonly approvalRequest: ApprovalGateRecord | null };

/**
 * The phase a just-recorded Approval Request read lands the screen in.
 *
 * A failed read is a REFUSAL, never a return to idle. The Worker has already
 * recorded a pending Approval Request by this point; dropping the operator back to
 * an untouched-looking form invites a retry that accumulates a second pending
 * request in the audit log that nobody asked for and nobody sees (ADR-0036).
 */
export function flagGatePhase(intent: FlagEditIntent, read: ApprovalReadResult): FlagEditPhase {
  return read.ok
    ? { phase: "gate", intent, request: read.data, confirming: false, error: null }
    : { phase: "refused", intent, error: mutationErrorSurface(read) };
}
