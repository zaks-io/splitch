import type { ApprovalPolicyContext, ApprovalRequest } from "@splitch/contracts";
import type { ConfigStoreWriter } from "./config-store";
import type { ConfigStoreAccess } from "./config-store-access";
import type { FlagConfigResult } from "./config-store-types";
import {
  renderFlagConfigReadFailure,
  renderFlagConfigWriteResult,
  renderPromotionResult,
} from "./flag-config-handler-render";
import {
  type CreateApprovalInput,
  type ApprovalServiceDeps,
  createApproval,
  replayApprovalIfExists,
} from "./approval-service";

type ApprovalFlowDeps = Omit<ApprovalServiceDeps, "configStore"> & {
  readonly configStore: ConfigStoreAccess;
};

type ApprovalIdentity = Pick<
  CreateApprovalInput,
  | "appId"
  | "operation"
  | "target"
  | "proposalInput"
  | "principal"
  | "idempotencyKey"
  | "inlineReview"
  | "requestId"
>;

interface FlagConfigApprovalFlowInput extends ApprovalIdentity {
  readonly environmentId: string;
  readonly flagId: string;
  readonly responseKind: "configuration" | "promotion";
}

interface ApprovalRequestInput {
  readonly policyContexts: ApprovalPolicyContext[];
  readonly preview: () => ReturnType<ConfigStoreWriter["previewFlagConfig"]>;
}

/**
 * Approval workflow shared by every Flag Configuration mutation route.
 * Callers replay before their Run-freeze and Policy reads, then request only
 * when their resolved Policy contexts require Review.
 */
export function flagConfigApprovalFlow(deps: ApprovalFlowDeps, input: FlagConfigApprovalFlowInput) {
  const writer = deps.configStore.writerFor(input.appId, input.environmentId);
  const readInput = {
    appId: input.appId,
    environmentId: input.environmentId,
    flagId: input.flagId,
  };

  return {
    async replay(): Promise<Response | null> {
      const replay = await replayApprovalIfExists(deps, input, { ignoreMismatch: true });
      if (replay === null) return null;
      if (!replay.ok) return replay.response;
      return appliedResponse(writer, readInput, input, replay.approvalRequest);
    },

    async request(request: ApprovalRequestInput): Promise<Response> {
      const [current, preview] = await Promise.all([
        writer.readFlagConfig(readInput),
        request.preview(),
      ]);
      if (!current.ok) return renderFlagConfigReadFailure(current, input.requestId);
      if (!preview.ok) return previewFailure(preview, input);

      const approval = await createApproval(deps, {
        ...input,
        policyContexts: request.policyContexts,
        current: approvalProjection(current.config),
        proposed: approvalProjection(preview.config),
      });
      if (!approval.ok) return approval.response;
      return appliedResponse(writer, readInput, input, approval.approvalRequest);
    },
  };
}

function approvalProjection(config: FlagConfigResult): Record<string, unknown> {
  return { ...config };
}

async function appliedResponse(
  writer: ConfigStoreWriter,
  readInput: Parameters<ConfigStoreWriter["readFlagConfig"]>[0],
  input: FlagConfigApprovalFlowInput,
  approvalRequest: ApprovalRequest,
): Promise<Response> {
  const applied = await writer.readFlagConfig(readInput);
  if (!applied.ok) return renderFlagConfigReadFailure(applied, input.requestId);
  if (input.responseKind === "promotion") {
    return Response.json({
      ...applied.config,
      diff: {
        before: approvalRequest.diff.current,
        after: approvalRequest.diff.proposed,
      },
      approvalRequest,
    });
  }
  return Response.json({ ...applied.config, approvalRequest });
}

function previewFailure(
  result: Extract<Awaited<ReturnType<ConfigStoreWriter["previewFlagConfig"]>>, { ok: false }>,
  input: FlagConfigApprovalFlowInput,
): Response {
  return input.responseKind === "promotion"
    ? renderPromotionResult(result, input.flagId, input.environmentId, input.requestId, null)
    : renderFlagConfigWriteResult(result, input.flagId, input.environmentId, input.requestId, null);
}
