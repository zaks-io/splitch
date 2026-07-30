import type { EnvScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model";
import {
  decisionLocked,
  experimentNotFound,
  runFrozen,
  runFrozenUnstageable,
  variantSetNotPatchable,
} from "./experiment-errors";
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

/**
 * Assignment fields the Experiment can hold a draft for. Staging one writes a
 * `draft*` column and leaves the running Run's frozen snapshot alone.
 */
const STAGEABLE_ASSIGNMENT_FIELDS = ["allocation", "salt", "targetingRules", "segmentIds"] as const;

/**
 * Assignment fields with no `draft*` column. They live only on the live
 * Experiment row, which the running Run's ExperimentConfigKV publishes, so
 * writing one mid-Run would repoint a frozen Run. `stageForNextRun` cannot
 * launder them: a running Run freezes them outright.
 */
const RUN_FROZEN_ASSIGNMENT_FIELDS = [
  "flagId",
  "targetingKey",
  "targetingKeyType",
  "activationMetricId",
] as const;

const ASSIGNMENT_FIELDS = [
  ...RUN_FROZEN_ASSIGNMENT_FIELDS,
  ...STAGEABLE_ASSIGNMENT_FIELDS,
  "variantSet",
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

/**
 * The guard verdict plus the Run it was decided against.
 *
 * The caller needs the same Run to build the patch. Re-reading it would let the
 * guard and the write disagree about whether a Run is running, so the row could
 * be written under rules that were never checked against it.
 */
export interface ExperimentPatchGuard {
  response: Response | null;
  runningRun: RunRow | null;
}

export async function validateExperimentPatch(
  deps: ExperimentDeps,
  scope: EnvScope,
  experiment: ExperimentRow,
  body: Record<string, unknown>,
  requestId: string,
): Promise<ExperimentPatchGuard> {
  if (body.variantSet !== undefined) {
    return { response: variantSetNotPatchable(requestId), runningRun: null };
  }
  const runningRun = await runningRunForExperiment(deps.repo, scope, experiment);
  if (!runningRun) return { response: null, runningRun: null };
  const assignmentFields = presentFields(body, ASSIGNMENT_FIELDS);
  if (assignmentFields.length > 0 && body.stageForNextRun !== true) {
    return {
      response: runFrozen(runningRun.id, assignmentFields, "PATCH_EXPERIMENT", requestId),
      runningRun,
    };
  }
  const unstageable = changedRunFrozenFields(experiment, body);
  if (unstageable.length > 0) {
    return { response: runFrozenUnstageable(runningRun.id, unstageable, requestId), runningRun };
  }
  return {
    response:
      body.confidenceLevel !== undefined
        ? decisionLocked(runningRun.id, ["confidenceLevel"], "PATCH_EXPERIMENT", requestId)
        : null,
    runningRun,
  };
}

/**
 * Which `RUN_FROZEN_ASSIGNMENT_FIELDS` the body would actually change. Resending
 * the current value is a no-op, so the Panel's pre-filled next-Run form keeps
 * working; only a real edit is rejected.
 */
function changedRunFrozenFields(
  experiment: ExperimentRow,
  body: Record<string, unknown>,
): string[] {
  const live: Record<(typeof RUN_FROZEN_ASSIGNMENT_FIELDS)[number], string | null> = {
    flagId: experiment.flagId,
    targetingKey: experiment.targetingKeyField,
    targetingKeyType: experiment.targetingKeyType,
    activationMetricId: experiment.activationMetricId,
  };
  return RUN_FROZEN_ASSIGNMENT_FIELDS.filter((field) => {
    const requested = body[field];
    if (requested === undefined) return false;
    const normalized = field === "activationMetricId" ? nullableString(requested) : requested;
    return normalized !== live[field];
  }).map((field) => `experiment.${field}`);
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
      experiment,
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
  experiment: ExperimentRow,
  runningRun?: RunRow | null,
): ExperimentPatch {
  const patch: ExperimentPatch = {
    ...(runningRun && body.stageForNextRun === true
      ? nextRunDraftPatch(body, experiment, runningRun)
      : draftPatch(body)),
    updatedAt: nowIso(deps),
    updatedBy: userId,
  };
  applyPatchField(patch, body, "name", "name");
  applyPatchField(patch, body, "description", "description");
  applyPatchField(patch, body, "hypothesis", "hypothesis");
  applyPatchField(patch, body, "owner", "owner");
  applyPatchField(patch, body, "tags", "tags", json);
  applyPatchField(patch, body, "confidenceLevel", "confidenceLevel");
  applyPatchField(patch, body, "metrics", "metrics", json);
  applyPatchField(patch, body, "guardrailMetrics", "guardrailMetrics", json);
  applyPatchField(patch, body, "conversionWindowMs", "conversionWindowMs");
  applyPatchField(patch, body, "dimensions", "dimensions", json);
  // These have no draft column, so the running Run's published ExperimentConfig
  // reads them straight off the live row. `runningRun` is what the caller's read
  // showed, and that read is already stale here — this skip is therefore a
  // property of the caller, not an invariant of the patch builder, and on its
  // own it would still let a PATCH decided against a draft Experiment land on a
  // row a Run has since frozen.
  //
  // What actually closes that window is the compare-and-set in
  // `updateExperiment`: the write only lands while the Experiment's live Run id
  // is still the one the guard ruled against, so a Run that Starts in between
  // takes the write out and the whole decision is replayed. Skipping the fields
  // here and the compare-and-set there are two halves of one guarantee —
  // ADR-0002's frozen assignment config, which ADR-0003 says only a new Run may
  // change — and neither half holds alone.
  if (!runningRun) {
    applyPatchField(patch, body, "flagId", "flagId");
    applyPatchField(patch, body, "targetingKey", "targetingKeyField");
    applyPatchField(patch, body, "targetingKeyType", "targetingKeyType");
    applyPatchField(patch, body, "activationMetricId", "activationMetricId", nullableString);
    if (body.flagId !== undefined) patch.defaultVariantId = defaultVariantId;
  }
  return patch;
}

/**
 * Merge this PATCH into the Experiment's existing next-Run draft. Every key is
 * written unconditionally (the row may hold a partial draft), so each fallback
 * has to be the current draft value, not the running Run's frozen one —
 * otherwise a second incremental stage silently reverts the first.
 */
function nextRunDraftPatch(
  body: Record<string, unknown>,
  experiment: ExperimentRow,
  runningRun: RunRow,
): ExperimentPatch {
  const staged = draftPatch(body);
  return {
    draftAllocation:
      staged.draftAllocation ??
      experiment.draftAllocation ??
      json(jsonObject<Record<string, number>>(runningRun.allocation) ?? {}),
    // null means "generate a fresh salt at Start", which preserves the new Run
    // boundary even when allocation is the only visible change. An explicit
    // salt override wins, and a previously staged override survives.
    draftSalt: body.salt !== undefined ? String(body.salt) : experiment.draftSalt,
    draftTargetingRules:
      staged.draftTargetingRules ??
      experiment.draftTargetingRules ??
      json(jsonArray(runningRun.targetingRules)),
    // A frozen Run contains resolved Targeting Rules, not Segment references.
    // Carry the resolved snapshot forward rather than silently widening traffic.
    draftSegmentIds: staged.draftSegmentIds ?? experiment.draftSegmentIds ?? json([]),
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
