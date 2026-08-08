import { TargetingRuleSchema } from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";

type SegmentFlagConfigurationDependency = {
  flagConfigurationId: string;
  flagId: string;
  flagKey: string;
  flagName: string;
  environmentId: string;
  environmentKey: string;
  environmentName: string;
  targetingRuleIds: string[];
};

type SegmentExperimentDraftDependency = {
  experimentId: string;
  experimentName: string;
  environmentId: string;
  environmentKey: string;
  environmentName: string;
};

export type SegmentDependencies = {
  flagConfigurations: SegmentFlagConfigurationDependency[];
  experimentDrafts: SegmentExperimentDraftDependency[];
};

const StoredTargetingRulesSchema = TargetingRuleSchema.array();

export async function segmentDependencies(
  repo: Repository,
  appId: string,
  segmentId: string,
): Promise<SegmentDependencies> {
  const flagConfigurations = await flagConfigurationDependencies(repo, appId, segmentId);
  const experimentDrafts = await experimentDraftDependencies(repo, appId, segmentId);
  return { flagConfigurations, experimentDrafts };
}

async function flagConfigurationDependencies(
  repo: Repository,
  appId: string,
  segmentId: string,
): Promise<SegmentFlagConfigurationDependency[]> {
  const rules = await repo.flags.listTargetingRulesBySegment(appScope(appId), segmentId);
  const groups = new Map<string, typeof rules>();
  for (const rule of rules) {
    const key = `${rule.environmentId}\u0000${rule.flagId}`;
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }

  return Promise.all(
    [...groups.values()].map(async (group) => {
      const first = group[0];
      if (!first) throw new Error("Segment dependency group is empty");
      const [config, flag, environment] = await Promise.all([
        repo.flags.getFlagConfig(envScope(appId, first.environmentId), first.flagId),
        repo.flags.getFlag(appScope(appId), first.flagId),
        repo.identity.getEnvironment(appScope(appId), first.environmentId),
      ]);
      if (!config || !flag || !environment) {
        throw new Error("Targeting Rule dependency references a missing resource");
      }
      return {
        flagConfigurationId: config.id,
        flagId: first.flagId,
        flagKey: flag.key,
        flagName: flag.name,
        environmentId: first.environmentId,
        environmentKey: environment.key,
        environmentName: environment.name,
        targetingRuleIds: group.map((rule) => rule.id).sort(),
      };
    }),
  );
}

async function experimentDraftDependencies(
  repo: Repository,
  appId: string,
  segmentId: string,
): Promise<SegmentExperimentDraftDependency[]> {
  const dependencies: SegmentExperimentDraftDependency[] = [];
  const environments = await repo.identity.listEnvironments(appScope(appId));
  for (const environment of environments) {
    const experiments = await repo.experiments.listExperiments(envScope(appId, environment.id));
    for (const experiment of experiments) {
      if (
        !draftReferencesSegment(
          experiment.draftSegmentIds,
          experiment.draftTargetingRules,
          segmentId,
        )
      ) {
        continue;
      }
      dependencies.push({
        experimentId: experiment.id,
        experimentName: experiment.name,
        environmentId: environment.id,
        environmentKey: environment.key,
        environmentName: environment.name,
      });
    }
  }
  return dependencies;
}

function draftReferencesSegment(
  rawSegmentIds: string | null,
  rawTargetingRules: string | null,
  segmentId: string,
): boolean {
  const segmentIds = rawSegmentIds ? stringArray(JSON.parse(rawSegmentIds)) : [];
  if (segmentIds.includes(segmentId)) return true;
  const rules = rawTargetingRules
    ? StoredTargetingRulesSchema.parse(JSON.parse(rawTargetingRules))
    : [];
  return rules.some((rule) => rule.segmentId === segmentId);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Experiment draft Segment references are malformed");
  }
  return value;
}
