import { envScope, type Repository } from "@splitch/db";

export type EnvironmentRows = Awaited<ReturnType<Repository["identity"]["listEnvironments"]>>;

export interface RunningBlocker {
  experimentId: string;
  runId: string;
}

/**
 * How many Environments name this Variant EXPLICITLY in their available set.
 *
 * This is deliberately NOT the servability question `servesVariant` answers: an
 * empty available set serves the whole catalog but names nothing, so removing
 * the Variant leaves no dangling reference behind and the count is 0. Keeping
 * the two questions separate — and named apart — is the point: they were once
 * conflated, and the disagreement let a delete slip through a gate that the
 * servability rule would have caught.
 */
export async function explicitVariantReferenceCount(
  repo: Repository,
  appId: string,
  flagId: string,
  variantName: string,
  envs: EnvironmentRows,
): Promise<number> {
  let count = 0;
  for (const env of envs) {
    const config = await repo.flags.getFlagConfig(envScope(appId, env.id), flagId);
    const available = config ? (JSON.parse(config.availableVariantNames) as string[]) : [];
    if (available.includes(variantName)) count += 1;
  }
  return count;
}

export interface TargetingRuleVariantRef {
  id: string;
  environmentId: string;
}

/**
 * Targeting Rules that name this Variant by `variant_id`.
 *
 * Distinct from `explicitVariantReferenceCount` (available-set names) and from
 * `servesVariant` (would this Environment serve it). A rule can point at a
 * Variant that no Environment lists, and deleting the Variant would leave that
 * `variant_id` dangling.
 */
export async function targetingRulesReferencingVariant(
  repo: Repository,
  appId: string,
  flagId: string,
  variantId: string,
  envs: EnvironmentRows,
): Promise<TargetingRuleVariantRef[]> {
  const refs: TargetingRuleVariantRef[] = [];
  for (const env of envs) {
    const rules = await repo.flags.listTargetingRules(envScope(appId, env.id), flagId);
    for (const rule of rules) {
      if (rule.variantId === variantId) {
        refs.push({ id: rule.id, environmentId: env.id });
      }
    }
  }
  return refs.sort((left, right) => {
    const byEnv = left.environmentId.localeCompare(right.environmentId);
    return byEnv !== 0 ? byEnv : left.id.localeCompare(right.id);
  });
}

export interface ExperimentReference {
  experimentId: string;
  status: string;
  runId?: string;
}

export async function experimentReferencingFlag(
  repo: Repository,
  appId: string,
  flagId: string,
  envs: EnvironmentRows,
): Promise<ExperimentReference | null> {
  let fallback: ExperimentReference | null = null;
  for (const env of envs) {
    const scope = envScope(appId, env.id);
    const reference = await firstFlagExperimentReference(repo, scope, flagId);
    if (!reference) continue;
    if (reference.status === "running") return reference;
    fallback ??= reference;
  }
  return fallback;
}

async function firstFlagExperimentReference(
  repo: Repository,
  scope: ReturnType<typeof envScope>,
  flagId: string,
): Promise<ExperimentReference | null> {
  let fallback: ExperimentReference | null = null;
  // Unfiltered: archived Experiments leave listExperiments but still hold the
  // flag_id FK. Skip archived so only live (draft/running/ended) rows block;
  // Flag delete then hard-purges archived rows before removing the Flag.
  const experiments = await repo.experiments.experiments.findMany(scope);
  for (const experiment of experiments) {
    if (experiment.flagId !== flagId) continue;
    if (experiment.status === "archived") continue;
    if (experiment.status === "running") {
      return runningExperimentReference(repo, scope, experiment);
    }
    fallback ??= { experimentId: experiment.id, status: experiment.status };
  }
  return fallback;
}

function runningExperimentReference(
  repo: Repository,
  scope: ReturnType<typeof envScope>,
  experiment: { id: string; status: string; liveRunId: string | null },
): Promise<ExperimentReference> {
  const runPromise = experiment.liveRunId
    ? repo.experiments.getRun(scope, experiment.liveRunId)
    : Promise.resolve(null);
  return runPromise.then((run) => ({
    experimentId: experiment.id,
    status: experiment.status,
    runId: run?.id ?? experiment.liveRunId ?? "unknown",
  }));
}

/**
 * There is deliberately no `runningExperimentForVariant` here any more.
 *
 * This module used to carry its own environment-walking copy of "is a live Run
 * using this Variant?", and it had already drifted from the repository's answer
 * on whether `runs.ended_at IS NULL` counts. SPL-118 was bitten twice by exactly
 * that pattern, so the question now has ONE implementation —
 * `repo.flags.liveRunUsingVariant` — which is also the predicate `updateVariant`
 * enforces before it writes.
 */
