import type { MetricRef } from "@splitch/contracts";
import { appScope, type EnvScope, envScope, type Repository } from "@splitch/db";
import { requireAppWrite } from "./app-authz";
import { appNotFound } from "./app-environment-model";
import type { ConfigStoreAccess } from "./config-store-do";
import { type ExperimentRow, json, type RunRow } from "./experiment-model";
import { flagNotFound, validationError } from "./flag-definition-errors";
import { pathParam } from "./handler-input";

export interface ExperimentDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  nowIso?: () => string;
}

export interface RunningExperimentBlocker {
  experimentId: string;
  runId: string;
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

export async function blockingRunningExperimentForStart(
  repo: Repository,
  scope: EnvScope,
  experiment: ExperimentRow,
): Promise<RunningExperimentBlocker | null> {
  const running = await repo.experiments.findRunningExperimentsForFlag(scope, experiment.flagId);
  const blocker = running.find((candidate) => candidate.id !== experiment.id);
  if (!blocker) return null;
  const run = blocker.liveRunId ? await repo.experiments.getRun(scope, blocker.liveRunId) : null;
  return { experimentId: blocker.id, runId: run?.id ?? blocker.liveRunId ?? "unknown" };
}

/**
 * `variantSet` used to reach here and synthesize an equal split from the Variant
 * names. It cannot any more: Create does not accept the field and Patch rejects
 * it with a 400 before the patch is built, so the derived-allocation branch was
 * dead code that only made the write path look like it had a second source of
 * allocation truth. Allocation now comes from `allocation` or not at all.
 */
export function draftPatch(body: Record<string, unknown>) {
  return {
    ...(body.allocation !== undefined
      ? { draftAllocation: json(body.allocation as Record<string, number>) }
      : {}),
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
  actor: { id: string; scopes: readonly string[] },
  requestId: string,
): Promise<Response | null> {
  if (!(await environmentExists(deps, scope))) return appNotFound(requestId);
  return requireAppWrite(deps, scope.appId, actor, requestId);
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

export async function syncExperimentConfigFromD1(
  configStore: ConfigStoreAccess,
  scope: EnvScope,
  experimentId: string,
) {
  return configStore.writerFor(scope.appId, scope.environmentId).syncExperimentConfig({
    appId: scope.appId,
    environmentId: scope.environmentId,
    experimentId,
  });
}
