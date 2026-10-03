import {
  boundListRead,
  detectStaleReasons,
  FLAG_UNIFORM_SERVING_HISTORY_WINDOW_DAYS,
  PercentageRolloutSchema,
  type EnvironmentConfigState,
  type StaleFlagItem,
  type StaleFlagSignals,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import { flagFrom } from "./flag-definition-model";
import { pathParam } from "./handler-input";
import { FLAG_LIST_READ_LIMIT } from "./overview-thresholds";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type FlagRow = Awaited<ReturnType<Repository["flags"]["listFlagPage"]>>[number];
type StaleDetectionSnapshot = Awaited<
  ReturnType<Repository["flagHealth"]["loadStaleDetectionSnapshot"]>
>;

/**
 * Configuration-state stale detection (plan 3.6). Suggest only: no archive, no
 * writes. Serving evidence is always `unverified` because ordinary Flag reads
 * record no served Variant.
 */
export async function listStaleFlags(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const scope = appScope(appId);
  const now = nowIso(deps);
  const [app, scanned] = await Promise.all([
    deps.repo.identity.getApp(appId),
    deps.repo.flags.listFlagPage(scope, FLAG_LIST_READ_LIMIT + 1),
  ]);
  if (!app) return appNotFound(requestId);

  const {
    items: rows,
    readLimit,
    readTruncated,
    cursor,
  } = boundListRead(scanned, FLAG_LIST_READ_LIMIT);
  if (rows.length === 0) {
    return Response.json({ items: [], readTruncated, readLimit, cursor });
  }

  const environments = await deps.repo.identity.listEnvironments(scope);
  const environmentIds = environments.map((environment) => environment.id);
  if (environmentIds.length === 0) {
    throw new Error(`stale_flags_list: App ${appId} has no Environments`);
  }

  const context = await loadStaleDetectionContext(deps.repo, scope, rows, environmentIds, now);
  const items = rows.flatMap((row) => {
    const item = staleItemForFlag(row, environmentIds, context, now);
    return item ? [item] : [];
  });

  return Response.json({ items, readTruncated, readLimit, cursor });
}

type StaleDetectionContext = {
  catalogs: Awaited<ReturnType<Repository["flags"]["listVariantsForFlags"]>>;
  snapshot: StaleDetectionSnapshot;
  configByScope: Map<string, StaleDetectionSnapshot["configs"][number]>;
  ruleCountByScope: Map<string, number>;
  runningExperimentScopes: Set<string>;
};

async function loadStaleDetectionContext(
  repo: Repository,
  scope: ReturnType<typeof appScope>,
  rows: readonly FlagRow[],
  environmentIds: readonly string[],
  now: string,
): Promise<StaleDetectionContext> {
  const flagIds = rows.map((row) => row.id);
  const windowStartIso = new Date(
    Date.parse(now) - FLAG_UNIFORM_SERVING_HISTORY_WINDOW_DAYS * MS_PER_DAY,
  ).toISOString();
  const [catalogs, snapshot] = await Promise.all([
    repo.flags.listVariantsForFlags(scope, flagIds),
    repo.flagHealth.loadStaleDetectionSnapshot(scope, flagIds, environmentIds, windowStartIso),
  ]);

  const configByScope = new Map(
    snapshot.configs.map((config) => [scopeKey(config.flagId, config.environmentId), config]),
  );
  const ruleCountByScope = new Map<string, number>();
  for (const rule of snapshot.targetingRules) {
    const key = scopeKey(rule.flagId, rule.environmentId);
    ruleCountByScope.set(key, (ruleCountByScope.get(key) ?? 0) + 1);
  }

  return {
    catalogs,
    snapshot,
    configByScope,
    ruleCountByScope,
    runningExperimentScopes: new Set(
      snapshot.runningExperiments.map((experiment) =>
        scopeKey(experiment.flagId, experiment.environmentId),
      ),
    ),
  };
}

function staleItemForFlag(
  row: FlagRow,
  environmentIds: readonly string[],
  context: StaleDetectionContext,
  now: string,
): StaleFlagItem | null {
  const configurations = environmentConfigsForFlag(row.id, environmentIds, context);
  const detected = detectStaleReasons({
    lifecycleClass: row.lifecycleClass,
    expiresAt: row.expiresAt,
    flagUpdatedAt: row.updatedAt,
    lastChangeLogAt: context.snapshot.lastChangeByFlag.get(row.id) ?? null,
    configurations,
    now,
    runHistory: context.snapshot.hasInWindowLegacyRuns ? "unavailable" : "available",
  });
  if (!shouldIncludeStaleItem(detected)) return null;
  const flag = flagFrom(row, context.catalogs.get(row.id) ?? []);
  if (detected.uniformServing.state === "unknown") {
    return {
      flag,
      reasons: detected.reasons,
      servingEvidence: detected.servingEvidence,
      uniformServing: detected.uniformServing,
    };
  }
  if (detected.reasons.length === 0) {
    throw new Error(`stale_flags_list: Flag ${row.id} has available Run history but no reasons`);
  }
  return {
    flag,
    reasons: detected.reasons,
    servingEvidence: detected.servingEvidence,
    uniformServing: detected.uniformServing,
  };
}

function shouldIncludeStaleItem(detected: StaleFlagSignals): boolean {
  if (detected.reasons.length > 0) return true;
  return detected.uniformServing.state === "unknown" && detected.configAloneUniformServing;
}

function environmentConfigsForFlag(
  flagId: string,
  environmentIds: readonly string[],
  context: StaleDetectionContext,
): EnvironmentConfigState[] {
  return environmentIds.map((environmentId) => {
    const key = scopeKey(flagId, environmentId);
    const config = context.configByScope.get(key);
    if (!config) {
      throw new Error(
        `stale_flags_list: Flag ${flagId} has no Configuration in Environment ${environmentId}`,
      );
    }
    return {
      environmentId,
      enabled: config.enabled,
      targetingRuleCount: context.ruleCountByScope.get(key) ?? 0,
      rolloutPercentage: rolloutPercentage(config.rollout),
      hasRunningExperiment: context.runningExperimentScopes.has(key),
      updatedAt: config.updatedAt,
      lastRunLifecycleAt: context.snapshot.runLifecycleByScope.get(key) ?? null,
    };
  });
}

function scopeKey(flagId: string, environmentId: string): string {
  return `${flagId}\0${environmentId}`;
}

function rolloutPercentage(rolloutJson: string | null): number | null {
  if (rolloutJson === null) return null;
  return PercentageRolloutSchema.parse(JSON.parse(rolloutJson)).percentage;
}
