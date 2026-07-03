import type { EnvScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model.js";
import { decisionLocked, experimentNotFound, runFrozen } from "./experiment-errors.js";
import { json, type ExperimentRow } from "./experiment-model.js";
import {
  draftPatch,
  loadFlagConfig,
  nullableString,
  presentFields,
  requireWritableEnvironment,
  runningRunForExperiment,
  validateMetricRefs,
  type ExperimentDeps,
} from "./experiment-handler-shared.js";
import { validationError } from "./flag-definition-errors.js";
import { pathParam } from "./handler-input.js";

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
  const writeError = await requireWritableEnvironment(
    deps,
    scope,
    args.principal.id,
    args.requestId,
  );
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
  if (assignmentFields.length > 0) {
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
    value: experimentPatchFromBody(body, flagConfig.defaultVariantId, deps, args.principal.id),
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
): ExperimentPatch {
  const patch: ExperimentPatch = {
    ...draftPatch(body),
    updatedAt: nowIso(deps),
    updatedBy: userId,
  };
  applyPatchField(patch, body, "name", "name");
  applyPatchField(patch, body, "description", "description");
  applyPatchField(patch, body, "hypothesis", "hypothesis");
  applyPatchField(patch, body, "flagId", "flagId");
  applyPatchField(patch, body, "targetingKey", "targetingKeyField");
  applyPatchField(patch, body, "targetingKeyType", "targetingKeyType");
  applyPatchField(patch, body, "confidenceLevel", "confidenceLevel");
  applyPatchField(patch, body, "metrics", "metrics", json);
  applyPatchField(patch, body, "guardrailMetrics", "guardrailMetrics", json);
  applyPatchField(patch, body, "activationMetricId", "activationMetricId", nullableString);
  applyPatchField(patch, body, "conversionWindowMs", "conversionWindowMs");
  applyPatchField(patch, body, "dimensions", "dimensions", json);
  applyPatchField(patch, body, "status", "status");
  if (body.flagId !== undefined) patch.defaultVariantId = defaultVariantId;
  return patch;
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
