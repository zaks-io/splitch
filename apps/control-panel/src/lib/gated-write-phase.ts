import { type MutationErrorSurface, mutationErrorSurface } from "./api";
import type { ApprovalGateRecord } from "./approval-gate-record";
import type { ApprovalReadResult } from "./control-plane-flag-mutations";

/**
 * Every state a Policy-gated write can be in, and the pure transitions into the
 * ones a Worker response decides.
 *
 * The transitions live here rather than inline in a hook so they are reachable
 * without a router or a Worker binding. A branch that only exists inside a
 * `setState` call cannot be tested, and an untestable fail-loud branch is one
 * refactor away from becoming a silent one (ADR-0036).
 *
 * The proposal is carried as its rendered `summary` rather than as the originating
 * intent, because the two writes that reach this machine — a Flag Configuration
 * edit and a Promotion between Environments — share the gate and share nothing
 * else about their inputs. What the gate needs is the operator's own words above
 * the Worker's diff; the shape that produced them is the caller's business.
 */
export type GatedWritePhase =
  | { readonly phase: "idle" }
  | { readonly phase: "saving" }
  | {
      readonly phase: "gate";
      readonly summary: string;
      readonly request: ApprovalGateRecord;
      readonly confirming: boolean;
      readonly error: MutationErrorSurface | null;
    }
  | {
      readonly phase: "refused";
      readonly summary: string;
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
export function gatedWritePhase(summary: string, read: ApprovalReadResult): GatedWritePhase {
  return read.ok
    ? { phase: "gate", summary, request: read.data, confirming: false, error: null }
    : { phase: "refused", summary, error: mutationErrorSurface(read) };
}
