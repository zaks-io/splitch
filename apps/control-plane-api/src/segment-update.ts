import {
  SegmentSchema,
  type ApprovalPolicyContext,
  type ApprovalRequest,
} from "@splitch/contracts";
import { type ApprovalCommit, appScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { createApproval, replayApprovalIfExists } from "./approval-service";
import { environmentPolicyContexts, requiresReview } from "./approval-target";
import { configStoreUnavailable } from "./experiment-errors";
import { readEnvironmentPolicy } from "./flag-config-policy";
import { type MetricSegmentDeps, segmentResponse, type SegmentRow } from "./metric-segment-shared";
import { type SegmentDependencies, segmentDependencies } from "./segment-dependencies";
import {
  renderRepublishFailure,
  republishFlagConfigurations,
  type SegmentRepublishFailure,
} from "./segment-republication";
import type { ApplicationOutcome } from "./approval-service-types";

interface SegmentUpdateInput {
  name?: string;
  description?: string;
  conditions?: unknown[];
  idempotency_key?: string;
  review?: unknown;
}

type SegmentUpdateResult =
  | { ok: true; segment: SegmentRow }
  | { ok: false; response: Response }
  | { ok: false; notApplied: true }
  | { ok: false; republishFailure: SegmentRepublishFailure };

interface SegmentUpdateArgs {
  appId: string;
  segment: SegmentRow;
  body: SegmentUpdateInput;
  principal: Principal;
  requestId: string;
  applyOther: (request: ApprovalRequest, commit: ApprovalCommit) => Promise<ApplicationOutcome>;
}

export async function updateSegmentMutation(
  deps: MetricSegmentDeps,
  args: SegmentUpdateArgs,
): Promise<Response> {
  const proposalInput = segmentProposalInput(args.body);
  const replay = await replaySegmentUpdate(deps, args, proposalInput);
  if (replay) return replay;

  const dependencies = await segmentDependencies(deps.repo, args.appId, args.segment.id);
  const review = await reviewSegmentUpdate(deps, args, dependencies, proposalInput);
  if (review) return review;

  const result = await commitSegmentUpdate(deps, args.appId, args.segment, args.body, dependencies);
  if (result.ok) return Response.json(segmentResponse(result.segment));
  if ("republishFailure" in result) {
    return renderRepublishFailure(args.requestId, result.republishFailure);
  }
  return renderSegmentMissing(args.requestId, args.segment.id);
}

async function replaySegmentUpdate(
  deps: MetricSegmentDeps,
  args: SegmentUpdateArgs,
  proposalInput: Record<string, unknown>,
): Promise<Response | null> {
  if (!args.body.idempotency_key) return null;
  const replay = await replayApprovalIfExists(
    { ...deps, applyOther: args.applyOther },
    {
      appId: args.appId,
      operation: "segments_update",
      target: { type: "segment", id: args.segment.id },
      proposalInput,
      principal: args.principal,
      idempotencyKey: args.body.idempotency_key,
      inlineReview: args.body.review !== undefined,
      requestId: args.requestId,
    },
    { ignoreMismatch: true },
  );
  if (!replay) return null;
  if (!replay.ok) return replay.response;
  return currentSegmentResponse(deps, args);
}

async function reviewSegmentUpdate(
  deps: MetricSegmentDeps,
  args: SegmentUpdateArgs,
  dependencies: SegmentDependencies,
  proposalInput: Record<string, unknown>,
): Promise<Response | null> {
  if (args.body.conditions === undefined || dependencies.flagConfigurations.length === 0) {
    return null;
  }
  if (!deps.configStore) return configStoreUnavailable(args.requestId);
  const contexts = await segmentPolicyContexts(deps, args.appId, dependencies);
  if (!requiresReview(contexts)) return null;
  if (!args.body.idempotency_key) return missingIdempotencyKey(args.requestId);
  const approval = await createApproval(
    { ...deps, applyOther: args.applyOther },
    {
      appId: args.appId,
      operation: "segments_update",
      target: { type: "segment", id: args.segment.id },
      policyContexts: contexts,
      current: segmentResponse(args.segment) as unknown as Record<string, unknown>,
      proposed: proposedSegment(args.segment, args.body),
      proposalInput,
      principal: args.principal,
      idempotencyKey: args.body.idempotency_key,
      inlineReview: args.body.review !== undefined,
      requestId: args.requestId,
    },
  );
  return approval.ok ? currentSegmentResponse(deps, args) : approval.response;
}

async function currentSegmentResponse(deps: MetricSegmentDeps, args: SegmentUpdateArgs) {
  const segment = await deps.repo.flags.getSegment(appScope(args.appId), args.segment.id);
  return segment
    ? Response.json(segmentResponse(segment))
    : renderSegmentMissing(args.requestId, args.segment.id);
}

export async function applyApprovedSegmentUpdate(
  deps: MetricSegmentDeps,
  appId: string,
  segment: SegmentRow,
  proposed: Record<string, unknown>,
  approval: ApprovalCommit,
): Promise<SegmentUpdateResult> {
  const parsed = SegmentSchema.safeParse(proposed);
  if (!parsed.success) {
    return {
      ok: false,
      response: renderError(
        {
          code: "VALIDATION_ERROR",
          message: "stored Segment proposal is invalid",
          details: {
            issues: [{ path: ["diff", "proposed"], message: "stored proposal is invalid" }],
          },
        },
        { requestId: approval.requestId },
      ),
    };
  }
  const dependencies = await segmentDependencies(deps.repo, appId, segment.id);
  return commitSegmentUpdate(
    deps,
    appId,
    segment,
    {
      name: parsed.data.name,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      conditions: parsed.data.conditions,
    },
    dependencies,
    approval,
  );
}

async function commitSegmentUpdate(
  deps: MetricSegmentDeps,
  appId: string,
  segment: SegmentRow,
  body: SegmentUpdateInput,
  dependencies: SegmentDependencies,
  approval?: ApprovalCommit,
): Promise<SegmentUpdateResult> {
  const updated = await deps.repo.flags.updateSegment(
    appScope(appId),
    segment.id,
    {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.conditions !== undefined ? { conditions: JSON.stringify(body.conditions) } : {}),
      updatedAt: approval?.reviewedAt ?? deps.nowIso?.() ?? new Date().toISOString(),
    },
    approval,
  );
  if (!updated)
    return approval ? { ok: false, notApplied: true } : { ok: false, response: new Response() };
  if (body.conditions === undefined) return { ok: true, segment: updated };
  const republishFailure = await republishFlagConfigurations(deps, appId, dependencies);
  return republishFailure ? { ok: false, republishFailure } : { ok: true, segment: updated };
}

async function segmentPolicyContexts(
  deps: MetricSegmentDeps,
  appId: string,
  dependencies: SegmentDependencies,
): Promise<ApprovalPolicyContext[]> {
  const environmentIds = [
    ...new Set(dependencies.flagConfigurations.map((dependency) => dependency.environmentId)),
  ].sort();
  const contexts: ApprovalPolicyContext[] = [];
  for (const environmentId of environmentIds) {
    const policy = await readEnvironmentPolicy(deps.repo, appId, environmentId);
    if (!policy) {
      throw new Error(`Environment ${environmentId} disappeared while updating Segment`);
    }
    contexts.push(...environmentPolicyContexts(environmentId, policy, ["targeting_rollout_value"]));
  }
  return contexts;
}

function proposedSegment(segment: SegmentRow, body: SegmentUpdateInput): Record<string, unknown> {
  return SegmentSchema.parse({
    ...segmentResponse(segment),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.conditions !== undefined ? { conditions: body.conditions } : {}),
  }) as unknown as Record<string, unknown>;
}

function segmentProposalInput(body: SegmentUpdateInput) {
  return {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.conditions !== undefined ? { conditions: body.conditions } : {}),
  };
}

function missingIdempotencyKey(requestId: string) {
  return renderError(
    {
      code: "VALIDATION_ERROR",
      message: "idempotency_key is required when Segment Conditions require review",
      details: {
        issues: [{ path: ["idempotency_key"], message: "required when review is required" }],
      },
    },
    { requestId },
  );
}

function renderSegmentMissing(requestId: string, segmentId: string) {
  return renderError(
    {
      code: "SEGMENT_NOT_FOUND",
      message: "Segment not found",
      details: { missingSegmentIds: [segmentId] },
    },
    { requestId },
  );
}
