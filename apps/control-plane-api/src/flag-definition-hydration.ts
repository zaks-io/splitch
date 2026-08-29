import {
  HydratedFlagResponseSchema,
  PercentageRolloutSchema,
  type TargetingRule,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { toTargetingRule } from "./config-store-shared";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import { flagFrom } from "./flag-definition-model";

type FlagRow = NonNullable<Awaited<ReturnType<FlagDefinitionDeps["repo"]["flags"]["getFlag"]>>>;
type VariantCatalogs = ReturnType<FlagDefinitionDeps["repo"]["flags"]["listVariantsForFlags"]>;
type EnvironmentRow = Awaited<
  ReturnType<Repository["flags"]["listEnvironmentsAcrossApps"]>
>[number];
type ConfigRow = Awaited<ReturnType<Repository["flags"]["listFlagConfigsAcrossApps"]>>[number];
type TargetingRuleRow = Awaited<
  ReturnType<Repository["flags"]["listTargetingRulesAcrossApps"]>
>[number];
type ExperimentRow = Awaited<
  ReturnType<Repository["flags"]["listRunningExperimentsAcrossApps"]>
>[number];

export async function hydrateFlags(
  deps: FlagDefinitionDeps,
  appId: string,
  rows: readonly FlagRow[],
  catalogsResult: VariantCatalogs,
  requestedEnvironmentIds?: readonly string[],
) {
  const scope = appScope(appId);
  const environments = await deps.repo.identity.listEnvironments(scope);
  const requested = requestedEnvironmentIds ? new Set(requestedEnvironmentIds) : null;
  const environmentIds = environments
    .filter((environment) => !requested || requested.has(environment.id))
    .map((environment) => environment.id);
  const flagIds = rows.map((row) => row.id);
  const [catalogs, configs, targetingRules, experiments] = await Promise.all([
    catalogsResult,
    deps.repo.flags.listFlagConfigsByFlagIdsAcrossEnvironments(scope, flagIds, environmentIds),
    deps.repo.flags.listTargetingRulesByFlagIdsAcrossEnvironments(scope, flagIds, environmentIds),
    deps.repo.experiments.listRunningExperimentsForFlagsAcrossEnvironments(
      scope,
      flagIds,
      environmentIds,
    ),
  ]);

  return composeHydratedFlags(
    rows,
    catalogs,
    environments,
    configs,
    targetingRules,
    experiments,
    requestedEnvironmentIds,
  );
}

/** Compose the shared hydrated wire shape after either App or multi-App reads. */
export function composeHydratedFlags(
  rows: readonly FlagRow[],
  catalogs: Awaited<VariantCatalogs>,
  environments: readonly EnvironmentRow[],
  configs: readonly ConfigRow[],
  targetingRules: readonly TargetingRuleRow[],
  experiments: readonly ExperimentRow[],
  requestedEnvironmentIds?: readonly string[],
) {
  const requested = requestedEnvironmentIds ? new Set(requestedEnvironmentIds) : null;
  const environmentIdsByApp = new Map<string, string[]>();
  for (const environment of environments) {
    if (requested && !requested.has(environment.id)) continue;
    const ids = environmentIdsByApp.get(environment.appId) ?? [];
    ids.push(environment.id);
    environmentIdsByApp.set(environment.appId, ids);
  }
  const configByScope = new Map(configs.map((config) => [scopeKey(config), config]));
  const rulesByScope = groupTargetingRules(targetingRules);
  const experimentByScope = new Map<string, { id: string; key: string }>();
  for (const experiment of experiments) {
    const key = scopeKey(experiment);
    if (experimentByScope.has(key)) {
      throw new Error(
        `hydrated flag read: multiple running Experiments control Flag ${experiment.flagId} in Environment ${experiment.environmentId}`,
      );
    }
    experimentByScope.set(key, { id: experiment.id, key: experiment.key });
  }

  return rows.map((row) =>
    HydratedFlagResponseSchema.parse({
      ...flagFrom(row, catalogs.get(row.id) ?? []),
      configurations: (environmentIdsByApp.get(row.appId) ?? []).map((environmentId) => {
        const key = scopeKey({ environmentId, flagId: row.id });
        const config = configByScope.get(key);
        if (!config) {
          throw new Error(
            `hydrated flag read: Flag ${row.id} has no Configuration in Environment ${environmentId}`,
          );
        }
        return {
          environmentId,
          enabled: config.enabled,
          availableVariantNames: JSON.parse(config.availableVariantNames) as string[],
          targetingRules: rulesByScope.get(key) ?? [],
          rollout:
            config.rollout === null
              ? null
              : PercentageRolloutSchema.parse(JSON.parse(config.rollout)),
          experiment: experimentByScope.get(key) ?? null,
        };
      }),
    }),
  );
}

function groupTargetingRules(rows: readonly TargetingRuleRow[]) {
  const grouped = new Map<string, TargetingRule[]>();
  for (const row of rows) {
    const key = scopeKey(row);
    const rules = grouped.get(key) ?? [];
    rules.push(toTargetingRule(row));
    grouped.set(key, rules);
  }
  for (const rules of grouped.values()) {
    rules.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }
  return grouped;
}

function scopeKey(value: { environmentId: string; flagId: string }): string {
  return JSON.stringify([value.environmentId, value.flagId]);
}
