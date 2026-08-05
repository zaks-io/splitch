import {
  type App,
  type ClientKey,
  type Environment,
  type EnvironmentPolicy,
  EnvironmentPolicySchema,
  type ResourceDeleteBlocker,
} from "@splitch/contracts";
import { type appScope, envScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import { collectEnvironmentDeleteBlockers } from "./app-delete-tree";
import { clientKeyResponse, provisionClientKey } from "./client-key-provisioning";
import type { ConfigStoreAccess } from "./config-store-do";
import { type CredentialCacheWriterAccess, randomHex } from "./credential-cache";

export interface AppEnvironmentDeps {
  repo: Repository;
  credentialStore?: KVNamespace;
  credentialCacheWriter?: CredentialCacheWriterAccess;
  configStore?: ConfigStoreAccess;
  nowIso?: () => string;
}

export type AppRow = NonNullable<Awaited<ReturnType<Repository["identity"]["getApp"]>>>;
export type EnvironmentRow = NonNullable<
  Awaited<ReturnType<Repository["identity"]["getEnvironment"]>>
>;

export const ALLOW_POLICY: EnvironmentPolicy = {
  variantAvailability: "allow",
  targetingRolloutValue: "allow",
  enabledState: "allow",
  startExperimentRun: "allow",
};

export const CONFIRM_POLICY: EnvironmentPolicy = {
  variantAvailability: "confirm",
  targetingRolloutValue: "confirm",
  enabledState: "confirm",
  startExperimentRun: "confirm",
};

export async function createEnvironmentRecord(
  deps: AppEnvironmentDeps,
  scope: ReturnType<typeof appScope>,
  appId: string,
  input: {
    key: string;
    name: string;
    policy: EnvironmentPolicy;
    actorId: string;
  },
): Promise<EnvironmentRow> {
  const now = nowIso(deps);
  return deps.repo.identity.environments.insert(scope, {
    id: `env_${randomHex(12)}`,
    appId,
    key: input.key,
    name: input.name,
    policy: JSON.stringify(input.policy),
    createdAt: now,
    updatedAt: now,
    createdBy: input.actorId,
  });
}

export async function provisionEnvironmentClientKeys(
  deps: AppEnvironmentDeps,
  appId: string,
  organizationId: string,
  environments: readonly EnvironmentRow[],
): Promise<[ClientKey, ClientKey]> {
  const keys = [];
  for (const env of environments) {
    const row = await provisionClientKey(deps, {
      appId,
      environmentId: env.id,
      organizationId,
      scope: envScope(appId, env.id),
    });
    keys.push(clientKeyResponse(row));
  }
  return keys as [ClientKey, ClientKey];
}

export async function firstRunningExperiment(
  deps: AppEnvironmentDeps,
  appId: string,
  environments: readonly EnvironmentRow[],
  attemptedOp: string,
  requestId: string,
): Promise<Response | null> {
  for (const environment of environments) {
    const error = await runningExperimentError(deps, appId, environment, attemptedOp, requestId);
    if (error) return error;
  }
  return null;
}

export async function runningExperimentError(
  deps: AppEnvironmentDeps,
  appId: string,
  environment: EnvironmentRow,
  attemptedOp: string,
  requestId: string,
): Promise<Response | null> {
  const scope = envScope(appId, environment.id);
  const experiment = await deps.repo.experiments.findRunningExperiment(scope);
  if (!experiment) return null;
  const run =
    (experiment.liveRunId
      ? await deps.repo.experiments.getRun(scope, experiment.liveRunId)
      : null) ?? (await deps.repo.experiments.findRunningRunForExperiment(scope, experiment.id));

  return renderError(
    {
      code: "EXPERIMENT_RUNNING",
      message: "running Experiment must be ended before deleting this resource",
      details: {
        experimentId: experiment.id,
        runningRunId: run?.id ?? experiment.liveRunId ?? "unknown",
        attemptedOp,
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    },
    { requestId },
  );
}

export async function deleteEnvironmentBlockedByChildren(
  deps: AppEnvironmentDeps,
  appId: string,
  environmentId: string,
  attemptedOp: string,
  requestId: string,
): Promise<Response | null> {
  const blockers = await collectEnvironmentDeleteBlockers(deps, appId, environmentId);
  if (blockers.length === 0) return null;
  return resourceNotEmptyFromBlockers(
    environmentId,
    "environment",
    blockers,
    attemptedOp,
    requestId,
  );
}

export function resourceNotEmptyFromBlockers(
  resourceId: string,
  resourceType: "app" | "environment",
  blockers: readonly ResourceDeleteBlocker[],
  attemptedOp: string,
  requestId: string,
): Response {
  const first = blockers[0];
  if (!first) {
    throw new Error("resourceNotEmptyFromBlockers requires at least one blocker");
  }
  return renderError(
    {
      code: "RESOURCE_NOT_EMPTY",
      message: "resource has children that must be deleted before this operation can continue",
      details: {
        resourceType,
        resourceId,
        childType: first.childType,
        childCount: first.children.length,
        attemptedOp,
        blockers: [...blockers],
      },
    },
    { requestId },
  );
}

export function appResponse(row: AppRow): App {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    key: row.key,
    ...(row.description ? { description: row.description } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function environmentResponse(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    appId: row.appId,
    key: row.key,
    name: row.name,
    policy: EnvironmentPolicySchema.parse(JSON.parse(row.policy)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function organizationNotFound(requestId: string): Response {
  return renderError(
    { code: "ORGANIZATION_NOT_FOUND", message: "organization not found", details: {} },
    { requestId },
  );
}

export function unusableAppKey(name: string, requestId: string): Response {
  return renderError(
    {
      code: "VALIDATION_ERROR",
      message: `no App key could be derived from name "${name}"; supply an explicit "key"`,
      details: { issues: [{ path: ["key"], message: "could not be derived from name" }] },
    },
    { requestId },
  );
}

export function appNotFound(requestId: string): Response {
  return renderError(
    { code: "APP_NOT_FOUND", message: "app not found", details: {} },
    { requestId },
  );
}

export function lastEnvironmentRequired(appId: string, requestId: string): Response {
  return renderError(
    {
      code: "LAST_ENVIRONMENT_REQUIRED",
      message: "app must retain at least one Environment",
      details: { appId },
    },
    { requestId },
  );
}

export function nowIso(deps: AppEnvironmentDeps): string {
  return deps.nowIso?.() ?? new Date().toISOString();
}
