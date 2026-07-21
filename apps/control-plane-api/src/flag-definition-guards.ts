import type { Variant } from "@splitch/contracts";
import { envScope, type Repository } from "@splitch/db";

export type EnvironmentRows = Awaited<ReturnType<Repository["identity"]["listEnvironments"]>>;
export type VariantRow = Awaited<ReturnType<Repository["flags"]["listVariants"]>>[number];

export interface RunningBlocker {
  experimentId: string;
  runId: string;
}

export async function availableVariantReferenceCount(
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
  const experiments = await repo.experiments.listExperiments(scope);
  for (const experiment of experiments) {
    if (experiment.flagId !== flagId) continue;
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

export async function runningExperimentForVariant(
  repo: Repository,
  appId: string,
  flagId: string,
  variant: VariantRow,
  envs: EnvironmentRows,
): Promise<RunningBlocker | null> {
  for (const env of envs) {
    const scope = envScope(appId, env.id);
    const experiment = await repo.experiments.findRunningExperimentForFlag(scope, flagId);
    if (!experiment) continue;

    const blocker = await variantBlockerForExperiment(repo, scope, experiment, variant);
    if (blocker) return blocker;
  }
  return null;
}

async function variantBlockerForExperiment(
  repo: Repository,
  scope: ReturnType<typeof envScope>,
  experiment: NonNullable<
    Awaited<ReturnType<Repository["experiments"]["findRunningExperimentForFlag"]>>
  >,
  variant: VariantRow,
): Promise<RunningBlocker | null> {
  const run =
    (experiment.liveRunId ? await repo.experiments.getRun(scope, experiment.liveRunId) : null) ??
    (await repo.experiments.findRunningRunForExperiment(scope, experiment.id));
  if (!run) return { experimentId: experiment.id, runId: experiment.liveRunId ?? "unknown" };
  return runReferencesVariant(run.variantSet, variant)
    ? { experimentId: experiment.id, runId: run.id }
    : null;
}

function runReferencesVariant(rawVariantSet: string, variant: VariantRow): boolean {
  const set = JSON.parse(rawVariantSet) as Variant[];
  return set.some((candidate) => candidate.id === variant.id || candidate.name === variant.name);
}
