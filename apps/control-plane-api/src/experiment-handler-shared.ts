import type { MetricRef, Variant } from "@splitch/contracts";
import { appScope, envScope, type EnvScope, type Repository } from "@splitch/db";
import { requireAppWrite } from "./app-authz.js";
import { appNotFound } from "./app-environment-model.js";
import type { ConfigStoreAccess } from "./config-store-do.js";
import { equalAllocation, json, type ExperimentRow, type RunRow } from "./experiment-model.js";
import { flagNotFound, validationError } from "./flag-definition-errors.js";
import { pathParam } from "./handler-input.js";

export interface ExperimentDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  nowIso?: () => string;
}

export async function experimentFromPath(
  deps: ExperimentDeps,
  input: unknown,
): Promise<ExperimentRow | null> {
  return deps.repo.experiments.getExperiment(
    envScope(pathParam(input, "appId"), pathParam(input, "environmentId")),
    pathParam(input, "experimentId"),
  );
}

export async function runningRunForExperiment(
  repo: Repository,
  scope: EnvScope,
  experiment: ExperimentRow,
): Promise<RunRow | null> {
  return (
    (experiment.liveRunId ? await repo.experiments.getRun(scope, experiment.liveRunId) : null) ??
    repo.experiments.findRunningRunForExperiment(scope, experiment.id)
  );
}

export function draftPatch(body: Record<string, unknown>) {
  const variantNames = Array.isArray(body.variantSet)
    ? (body.variantSet as Variant[]).map((variant) => variant.name)
    : [];
  const allocation =
    body.allocation !== undefined
      ? (body.allocation as Record<string, number>)
      : variantNames.length > 0
        ? equalAllocation(variantNames)
        : undefined;
  return {
    ...(allocation !== undefined ? { draftAllocation: json(allocation) } : {}),
    ...(body.salt !== undefined ? { draftSalt: body.salt as string } : {}),
    ...(body.targetingRules !== undefined
      ? { draftTargetingRules: json(body.targetingRules) }
      : {}),
    ...(body.segmentIds !== undefined ? { draftSegmentIds: json(body.segmentIds) } : {}),
  };
}

export async function loadFlagConfig(
  repo: Repository,
  scope: EnvScope,
  flagId: string,
  requestId: string,
) {
  const flag = await repo.flags.getFlag(appScope(scope.appId), flagId);
  const config = await repo.flags.getFlagConfig(scope, flagId);
  if (!flag || !config?.defaultVariantId) {
    return { ok: false as const, response: flagNotFound(requestId) };
  }
  return { ok: true as const, value: { defaultVariantId: config.defaultVariantId } };
}

export async function validateMetricRefs(
  repo: Repository,
  appId: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Response | null> {
  const refs = [
    ...((body.metrics as MetricRef[] | undefined) ?? []),
    ...((body.guardrailMetrics as MetricRef[] | undefined) ?? []),
    ...(typeof body.activationMetricId === "string" ? [{ metricId: body.activationMetricId }] : []),
  ];
  for (const ref of refs) {
    if (!(await repo.experiments.getMetric(appScope(appId), ref.metricId))) {
      return validationError(requestId, [["body", "metrics"], "Metric must belong to this App"]);
    }
  }
  return null;
}

export async function requireWritableEnvironment(
  deps: ExperimentDeps,
  scope: EnvScope,
  userId: string,
  requestId: string,
): Promise<Response | null> {
  if (!(await environmentExists(deps, scope))) return appNotFound(requestId);
  return requireAppWrite(deps, scope.appId, userId, requestId);
}

export async function environmentExists(deps: ExperimentDeps, scope: EnvScope): Promise<boolean> {
  return Boolean(
    await deps.repo.identity.getEnvironment(appScope(scope.appId), scope.environmentId),
  );
}

export function presentFields(body: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((field) => body[field] !== undefined).map((field) => `experiment.${field}`);
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function optionalBody(input: unknown): Record<string, unknown> {
  const body = (input as { body?: unknown }).body;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
