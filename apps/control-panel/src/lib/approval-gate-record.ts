import type { ApprovalRequest } from "@splitch/contracts";
import {
  type ApprovalDiffLabels,
  type ApprovalDiffRow,
  approvalDiffRows,
} from "./approval-diff-rows";

/**
 * The Approval Request as the confirm gate needs it: primitives only.
 *
 * The diff is turned into rows in the Control Plane-facing Worker, not in the
 * browser, for the same reason the Flag detail view model is derived there — the
 * screen receives an already-resolved projection and cannot form a second opinion
 * about what the proposal says.
 *
 * It is also what makes the record crossable: `ApprovalDiff` types its values as
 * `unknown`, which the server-function boundary cannot prove is transferable.
 */

export type ApprovalGatePolicyContext = {
  readonly environmentId: string;
  readonly changeTypes: readonly string[];
  readonly level: string;
};

export type ApprovalGateRecord = {
  readonly id: string;
  readonly status: string;
  readonly operation: string;
  readonly targetType: string;
  readonly proposerUserId: string;
  readonly proposedAt: string;
  readonly policyContexts: readonly ApprovalGatePolicyContext[];
  readonly rows: readonly ApprovalDiffRow[];
};

export function approvalGateRecord(
  request: ApprovalRequest,
  labels: ApprovalDiffLabels = {},
): ApprovalGateRecord {
  return {
    id: request.id,
    status: request.status,
    operation: request.operation,
    targetType: request.target.type,
    proposerUserId: request.proposer.userId,
    proposedAt: request.proposedAt,
    policyContexts: request.policyContexts.map((context) => ({
      environmentId: context.environmentId,
      changeTypes: [...context.changeTypes],
      level: context.level,
    })),
    rows: approvalDiffRows(request.diff, labels),
  };
}
