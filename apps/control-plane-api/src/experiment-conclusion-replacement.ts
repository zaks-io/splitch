import {
  ApprovalDiffSchema,
  type ApprovalRequest,
  canonicalHash,
  type CreateConclusionPromotionRequest,
  FlagConfigResponseSchema,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz";
import { approvalDiff, approvalRequestId } from "./approval-canonical";
import { approvalRequestProjection } from "./approval-model";
import { approvalTargetVersion, environmentPolicyContexts } from "./approval-target";
import { idempotencyConflict, requiredAuthDoor } from "./approval-review-outcomes";
import { buildSnapshotFromD1, responseFromSnapshot } from "./config-store-shared";
import { targetConfigurationStale } from "./experiment-conclusion-errors";
import { resolveReplacementGuardFailure } from "./experiment-conclusion-guard-errors";
import { winnerChangedFields, winnerConfirmFloor } from "./experiment-conclusion-policy";
import {
  conclusionPathIds,
  finishReplacement,
  winnerApprovalRow,
} from "./experiment-conclusion-response";
import { configStoreUnavailable, runNotFound } from "./experiment-errors";
import type { ExperimentDeps } from "./experiment-handler-shared";
import { flagConfigNotFound } from "./flag-config-errors";
import { readEnvironmentPolicy } from "./flag-config-policy";
import { validationErrors } from "./flag-definition-errors";
import { objectBody, pathParam } from "./handler-input";

type ConclusionRow = NonNullable<
  Awaited<ReturnType<ExperimentDeps["repo"]["experimentConclusions"]["get"]>>
>;

export async function createConclusionPromotionRequest(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const ids = conclusionPathIds(args.input);
  const conclusionId = pathParam(args.input, "conclusionId");
  const adminError = await requireAppAdmin(deps, ids.appId, args.principal, args.requestId);
  if (adminError) return adminError;
  const conclusion = await deps.repo.experimentConclusions.get(
    envScope(ids.appId, ids.environmentId),
    ids.experimentId,
    ids.runId,
    conclusionId,
  );
  if (!conclusion) return runNotFound(args.requestId);
  const body = objectBody(args.input) as CreateConclusionPromotionRequest;
  const requestHash = await canonicalHash({ ...ids, conclusionId, ...body });
  const replay = await replacementReplay(deps, args, conclusion, body, requestHash);
  if (replay) return replay;
  if (!deps.configStore) return configStoreUnavailable(args.requestId);

  const previous = await previousPromotionRequest(deps, ids.appId, conclusion.id);
  const prepared = await prepareReplacement(deps, args, conclusion, body, previous.row);
  if (!prepared.ok) return prepared.response;
  return commitReplacement(deps, args, {
    body,
    conclusion,
    requestHash,
    previous: previous.row,
    ordinal: previous.ordinal + 1,
    ...prepared.value,
  });
}

async function replacementReplay(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  conclusion: ConclusionRow,
  body: CreateConclusionPromotionRequest,
  requestHash: string,
) {
  const row = await deps.repo.approvals.getRequestByActorKey(
    appScope(conclusion.appId),
    args.principal.id,
    body.idempotencyKey,
  );
  if (!row) return null;
  if (row.requestHash !== requestHash) {
    return idempotencyConflict("approval_request", body.idempotencyKey, args.requestId);
  }
  const links = await deps.repo.experimentConclusions.listApprovalLinks(
    appScope(conclusion.appId),
    conclusion.id,
  );
  return links.some((link) => link.approvalRequestId === row.id)
    ? finishReplacement(deps, args, body, conclusion, row.id)
    : idempotencyConflict("approval_request", body.idempotencyKey, args.requestId);
}

async function previousPromotionRequest(deps: ExperimentDeps, appId: string, conclusionId: string) {
  const links = await deps.repo.experimentConclusions.listApprovalLinks(
    appScope(appId),
    conclusionId,
  );
  const link = links[0];
  if (!link) throw new Error("conclusion has no Approval Request link");
  const row = await deps.repo.approvals.getRequest(appScope(appId), link.approvalRequestId);
  if (!row) throw new Error("conclusion Approval Request link is broken");
  return { row, ordinal: link.ordinal };
}

async function prepareReplacement(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  conclusion: ConclusionRow,
  body: CreateConclusionPromotionRequest,
  previous: Awaited<ReturnType<typeof previousPromotionRequest>>["row"],
) {
  const previousContexts = JSON.parse(previous.policyContexts) as ApprovalRequest["policyContexts"];
  const currentPreviousTargetVersion = await approvalTargetVersion(
    deps.repo,
    conclusion.appId,
    { type: "flag_configuration", id: previous.targetId },
    previousContexts,
  );
  const projected = await approvalRequestProjection(deps.repo, previous);
  if (projected.status !== "stale" || currentPreviousTargetVersion === previous.targetVersion) {
    return { ok: false as const, response: replacementRequiresStale(args.requestId) };
  }
  const snapshot = await buildSnapshotFromD1(
    deps.repo,
    envScope(conclusion.appId, conclusion.targetEnvironmentId),
    conclusion.targetFlagId,
  );
  if (!snapshot) return { ok: false as const, response: flagConfigNotFound(args.requestId) };
  const current = responseFromSnapshot(snapshot);
  if (current.version !== body.expectedConfigVersion) {
    return {
      ok: false as const,
      response: targetConfigurationStale(
        conclusion.targetFlagId,
        conclusion.targetEnvironmentId,
        body.expectedConfigVersion,
        current.version,
        args.requestId,
      ),
    };
  }
  const frozen = FlagConfigResponseSchema.parse(JSON.parse(conclusion.proposedFlagConfiguration));
  const proposed = { ...frozen, version: current.version + 1, experiment: current.experiment };
  const changeTypes = winnerChangedFields(current, proposed);
  if (changeTypes.length === 0) {
    return { ok: false as const, response: replacementAlreadyMatches(args.requestId) };
  }
  const policy = await readEnvironmentPolicy(
    deps.repo,
    conclusion.appId,
    conclusion.targetEnvironmentId,
  );
  if (!policy) return { ok: false as const, response: flagConfigNotFound(args.requestId) };
  const policyGuardContexts = environmentPolicyContexts(
    conclusion.targetEnvironmentId,
    policy,
    changeTypes,
  );
  const contexts = winnerConfirmFloor(policyGuardContexts);
  const targetVersion = await approvalTargetVersion(
    deps.repo,
    conclusion.appId,
    { type: "flag_configuration", id: previous.targetId },
    contexts,
  );
  return {
    ok: true as const,
    value: {
      current,
      proposed,
      contexts,
      policyGuardContexts,
      targetVersion,
      currentPreviousTargetVersion,
    },
  };
}

async function commitReplacement(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  input: {
    body: CreateConclusionPromotionRequest;
    conclusion: ConclusionRow;
    requestHash: string;
    previous: Awaited<ReturnType<typeof previousPromotionRequest>>["row"];
    ordinal: number;
    current: ReturnType<typeof responseFromSnapshot>;
    proposed: ReturnType<typeof responseFromSnapshot>;
    contexts: ApprovalRequest["policyContexts"];
    policyGuardContexts: ApprovalRequest["policyContexts"];
    targetVersion: `sha256:${string}`;
    currentPreviousTargetVersion: `sha256:${string}`;
  },
) {
  const decision = {
    conclusionId: input.conclusion.id,
    runId: input.conclusion.runId,
    selectedVariant: input.conclusion.selectedVariant,
    resultToken: input.conclusion.resultToken,
  };
  const diff = ApprovalDiffSchema.parse(
    approvalDiff(
      { decision, flagConfiguration: input.current },
      { decision, flagConfiguration: input.proposed },
    ),
  );
  const now = deps.nowIso?.() ?? new Date().toISOString();
  const approvalId = approvalRequestId(new Date(now).getTime());
  try {
    const created = await deps.repo.experimentConclusions.createReplacement(
      appScope(input.conclusion.appId),
      {
        conclusionId: input.conclusion.id,
        previousApprovalRequestId: input.previous.id,
        ordinal: input.ordinal,
        approval: winnerApprovalRow({
          id: approvalId,
          targetId: input.previous.targetId,
          targetVersion: input.targetVersion,
          policyContexts: input.contexts,
          policyGuardContexts: input.policyGuardContexts,
          diff,
          proposedBy: args.principal.id,
          proposedVia: requiredAuthDoor(args.principal),
          proposedAt: now,
          idempotencyKey: input.body.idempotencyKey,
          requestHash: input.requestHash,
        }),
        targetEnvironmentId: input.conclusion.targetEnvironmentId,
        targetFlagId: input.conclusion.targetFlagId,
        expectedTargetConfigVersion: input.body.expectedConfigVersion,
        previousTargetVersion: input.previous.targetVersion,
        currentTargetVersion: input.currentPreviousTargetVersion,
        createdAt: now,
      },
    );
    if (!created) throw new Error("replacement Promotion Request lost its guarded D1 transaction");
  } catch (cause) {
    const resolved = await resolveReplacementGuardFailure(
      deps,
      args,
      {
        appId: input.conclusion.appId,
        targetEnvironmentId: input.conclusion.targetEnvironmentId,
        flagId: input.conclusion.targetFlagId,
        expectedConfigVersion: input.body.expectedConfigVersion,
        conclusionId: input.conclusion.id,
        idempotencyKey: input.body.idempotencyKey,
        requestHash: input.requestHash,
      },
      cause,
    );
    return resolved.kind === "replay"
      ? finishReplacement(deps, args, input.body, input.conclusion, resolved.approval.id)
      : resolved.response;
  }
  return finishReplacement(deps, args, input.body, input.conclusion, approvalId);
}

function replacementRequiresStale(requestId: string) {
  return validationErrors(requestId, [
    {
      path: ["body", "expectedConfigVersion"],
      message:
        "a replacement Promotion Request is allowed only after the previous request is stale",
    },
  ]);
}

function replacementAlreadyMatches(requestId: string) {
  return validationErrors(requestId, [
    {
      path: ["body", "expectedConfigVersion"],
      message: "target already matches the concluded Configuration",
    },
  ]);
}
