import type { ApprovalRequest, ErrorCode } from "@splitch/contracts";
import type { ApprovalCommit, Repository } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import type { ConfigStoreAccess } from "./config-store-do";

export interface ApprovalServiceDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  nowIso?: () => string;
  applyOther?: (
    request: ApprovalRequest,
    commit: ApprovalCommit,
  ) => Promise<
    { ok: true } | { ok: false; error: { code: ErrorCode; details: Record<string, unknown> } }
  >;
}

export type ApprovalResult =
  | { ok: true; approvalRequest: ApprovalRequest }
  | { ok: false; response: Response };

export type ApprovalRequestRow = NonNullable<
  Awaited<ReturnType<Repository["approvals"]["getRequest"]>>
>;

export type ApprovalReviewRow = NonNullable<
  Awaited<ReturnType<Repository["approvals"]["latestReview"]>>
>;

export interface ReviewApprovalInput {
  appId: string;
  approvalRequestId: string;
  action: "approve_and_apply" | "decline";
  reason: string | null;
  idempotencyKey: string;
  principal: Principal;
  requestId: string;
}
