import {
  boundListRead,
  detectStaleReasons,
  PercentageRolloutSchema,
  type EnvironmentConfigState,
  type StaleFlagItem,
} from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import { flagFrom } from "./flag-definition-model";
import { pathParam } from "./handler-input";
import { FLAG_LIST_READ_LIMIT } from "./overview-thresholds";

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
  const [app, scanned, lastChangeByFlag] = await Promise.all([
    deps.repo.identity.getApp(appId),
    deps.repo.flags.listFlagPage(scope, FLAG_LIST_READ_LIMIT + 1),
    deps.repo.flagHealth.latestChangeAtByFlagId(scope),
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

  const flagIds = rows.map((row) => row.id);
  const [catalogs, configs, targetingRules, experiments] = await Promise.all([
    deps.repo.flags.listVariantsForFlags(scope, flagIds),
    deps.repo.flags.listFlagConfigsByFlagIdsAcrossEnvironments(scope, flagIds, environmentIds),
    deps.repo.flags.listTargetingRulesByFlagIdsAcrossEnvironments(scope, flagIds, environmentIds),
    deps.repo.experiments.listRunningExperimentsForFlagsAcrossEnvironments(
      scope,
      flagIds,
      environmentIds,
    ),
  ]);

  const configByScope = new Map(
    configs.map((config) => [scopeKey(config.flagId, config.environmentId), config]),
  );
  const ruleCountByScope = new Map<string, number>();
  for (const rule of targetingRules) {
    const key = scopeKey(rule.flagId, rule.environmentId);
    ruleCountByScope.set(key, (ruleCountByScope.get(key) ?? 0) + 1);
  }
  const runningExperimentScopes = new Set(
    experiments.map((experiment) => scopeKey(experiment.flagId, experiment.environmentId)),
  );

  const items: StaleFlagItem[] = [];
  for (const row of rows) {
    const configurations: EnvironmentConfigState[] = environmentIds.map((environmentId) => {
      const key = scopeKey(row.id, environmentId);
      const config = configByScope.get(key);
      if (!config) {
        throw new Error(
          `stale_flags_list: Flag ${row.id} has no Configuration in Environment ${environmentId}`,
        );
      }
      return {
        environmentId,
        enabled: config.enabled,
        targetingRuleCount: ruleCountByScope.get(key) ?? 0,
        rolloutPercentage: rolloutPercentage(config.rollout),
        hasRunningExperiment: runningExperimentScopes.has(key),
        updatedAt: config.updatedAt,
      };
    });

    const detected = detectStaleReasons({
      lifecycleClass: row.lifecycleClass,
      expiresAt: row.expiresAt,
      flagUpdatedAt: row.updatedAt,
      lastChangeLogAt: lastChangeByFlag.get(row.id) ?? null,
      configurations,
      now,
    });
    if (detected.reasons.length === 0) continue;
    items.push({
      flag: flagFrom(row, catalogs.get(row.id) ?? []),
      reasons: detected.reasons,
      servingEvidence: detected.servingEvidence,
    });
  }

  return Response.json({ items, readTruncated, readLimit, cursor });
}

function scopeKey(flagId: string, environmentId: string): string {
  return `${flagId}\0${environmentId}`;
}

function rolloutPercentage(rolloutJson: string | null): number | null {
  if (rolloutJson === null) return null;
  return PercentageRolloutSchema.parse(JSON.parse(rolloutJson)).percentage;
}
