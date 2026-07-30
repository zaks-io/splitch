import type { EnvScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model";
import { decisionLocked, experimentNotFound, runFrozen } from "./experiment-errors";
import {
  draftPatch,
  type ExperimentDeps,
  loadFlagConfig,
  nullableString,
  presentFields,
  requireWritableEnvironment,
  runningRunForExperiment,
  validateMetricRefs,
} from "./experiment-handler-shared";
import { type ExperimentRow, json, jsonArray, jsonObject, type RunRow } from "./experiment-model";
import { validationError } from "./flag-definition-errors";
import { pathParam } from "./handler-input";

const ASSIGNMENT_FIELDS = [
  "flagId",
  "targetingKey",
  "targetingKeyType",
  "activationMetricId",
  "allocation",
  "salt",
  "variantSet",
  "targetingRules",
  "segmentIds",
] as const;

type ExperimentPatch = Parameters<ExperimentDeps["repo"]["experiments"]["updateExperiment"]>[2];

export async function validateCreateExperiment(
  deps: ExperimentDeps,
  scope: EnvScope,
  body: Record<string, unknown>,
  requestId: string,
): Promise<{ ok: true; defaultVariantId: string } | { ok: false; response: Response }> {
  const scopeError = createScopeError(scope, body, requestId);
  if (scopeError) return { ok: false, response: scopeError };
  const flagConfig = await loadFlagConfig(deps.repo, scope, body.flagId as string, requestId);
  if (!flagConfig.ok) return flagConfig;
  const metricIssue = await validateMetricRefs(deps.repo, scope.appId, body, requestId);
  if (metricIssue) return { ok: false, response: metricIssue };
  return { ok: true, defaultVariantId: flagConfig.value.defaultVariantId };
}

export async function loadUpdateContext(
  deps: ExperimentDeps,
  scope: EnvScope,
  args: HandlerArgs<unknown>,
) {
  const experiment = await deps.repo.experiments.getExperiment(
    scope,
    pathParam(args.input, "experimentId"),
  );
  if (!experiment) return { ok: false as const, response: experimentNotFound(args.requestId) };
  const writeError = await requireWritableEnvironment(deps, scope, args.principal, args.requestId);
  if (writeError) return { ok: false as const, response: writeError };
  return { ok: true as const, experiment };
}

export async function validateRunningPatch(
  deps: ExperimentDeps,
  scope: EnvScope,
  experiment: ExperimentRow,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Response | null> {
  const runningRun = await runningRunForExperiment(deps.repo, scope, experiment);
  if (!runningRun) return null;
  const assignmentFields = presentFields(body, ASSIGNMENT_FIELDS);
  if (assignmentFields.length > 0 && body.stageForNextRun !== true) {
    return runFrozen(runningRun.id, assignmentFields, "PATCH_EXPERIMENT", requestId);
  }
  return body.confidenceLevel !== undefined
    ? decisionLocked(runningRun.id, ["confidenceLevel"], "PATCH_EXPERIMENT", requestId)
    : null;
}

export async function prepareUpdatePatch(
  deps: ExperimentDeps,
  scope: EnvScope,
  experiment: ExperimentRow,
  body: Record<string, unknown>,
  args: HandlerArgs<unknown>,
  runningRun?: RunRow | null,
): Promise<{ ok: true; value: ExperimentPatch } | { ok: false; response: Response }> {
  const metricIssue = await validateMetricRefs(deps.repo, scope.appId, body, args.requestId);
  if (metricIssue) return { ok: false, response: metricIssue };
  const flagConfig = await defaultVariantForPatch(
    deps,
    scope,
    experiment.defaultVariantId,
    body,
    args.requestId,
  );
  if (!flagConfig.ok) return flagConfig;
  return {
    ok: true,
    value: experimentPatchFromBody(
      body,
      flagConfig.defaultVariantId,
      deps,
      args.principal.id,
      runningRun,
    ),
  };
}

function createScopeError(scope: EnvScope, body: Record<string, unknown>, requestId: string) {
  if (body.appId === scope.appId && body.environmentId === scope.environmentId) return null;
  return validationError(requestId, [
    ["body", body.appId !== scope.appId ? "appId" : "environmentId"],
    "body scope must match path scope",
  ]);
}

async function defaultVariantForPatch(
  deps: ExperimentDeps,
  scope: EnvScope,
  currentDefaultVariantId: string | null,
  body: Record<string, unknown>,
  requestId: string,
): Promise<{ ok: true; defaultVariantId: string | null } | { ok: false; response: Response }> {
  if (body.flagId === undefined) return { ok: true, defaultVariantId: currentDefaultVariantId };
  const flagConfig = await loadFlagConfig(deps.repo, scope, body.flagId as string, requestId);
  return flagConfig.ok
    ? { ok: true, defaultVariantId: flagConfig.value.defaultVariantId }
    : flagConfig;
}

function experimentPatchFromBody(
  body: Record<string, unknown>,
  defaultVariantId: string | null,
  deps: ExperimentDeps,
  userId: string,
  runningRun?: RunRow | null,
): ExperimentPatch {
  const patch: ExperimentPatch = {
    ...(runningRun && body.stageForNextRun === true
      ? nextRunDraftPatch(body, runningRun)
      : draftPatch(body)),
    updatedAt: nowIso(deps),
    updatedBy: userId,
  };
  applyPatchField(patch, body, "name", "name");
  applyPatchField(patch, body, "description", "description");
  applyPatchField(patch, body, "hypothesis", "hypothesis");
  applyPatchField(patch, body, "owner", "owner");
  applyPatchField(patch, body, "tags", "tags", json);
  applyPatchField(patch, body, "flagId", "flagId");
  applyPatchField(patch, body, "targetingKey", "targetingKeyField");
  applyPatchField(patch, body, "targetingKeyType", "targetingKeyType");
  applyPatchField(patch, body, "confidenceLevel", "confidenceLevel");
  applyPatchField(patch, body, "metrics", "metrics", json);
  applyPatchField(patch, body, "guardrailMetrics", "guardrailMetrics", json);
  applyPatchField(patch, body, "activationMetricId", "activationMetricId", nullableString);
  applyPatchField(patch, body, "conversionWindowMs", "conversionWindowMs");
  applyPatchField(patch, body, "dimensions", "dimensions", json);
  if (body.flagId !== undefined) patch.defaultVariantId = defaultVariantId;
  return patch;
}

function nextRunDraftPatch(body: Record<string, unknown>, runningRun: RunRow): ExperimentPatch {
  const staged = draftPatch(body);
  return {
    draftAllocation:
      staged.draftAllocation ??
      json(jsonObject<Record<string, number>>(runningRun.allocation) ?? {}),
    // A fresh salt preserves the new Run boundary even when allocation is the
    // only visible change. An explicit salt override still wins.
    draftSalt: body.salt === undefined ? null : String(body.salt),
    draftTargetingRules: staged.draftTargetingRules ?? json(jsonArray(runningRun.targetingRules)),
    // A frozen Run contains resolved Targeting Rules, not Segment references.
    // Carry the resolved snapshot forward rather than silently widening traffic.
    draftSegmentIds: staged.draftSegmentIds ?? json([]),
  };
}

function applyPatchField(
  patch: Record<string, unknown>,
  body: Record<string, unknown>,
  inputField: string,
  patchField: string,
  transform: (value: unknown) => unknown = (value) => value,
): void {
  if (body[inputField] !== undefined) patch[patchField] = transform(body[inputField]);
}
