import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import type {
  PanelExperimentDetailInput,
  PanelExperimentDetailOutput,
  PanelExperimentListItem,
} from "@splitch/control-plane-sdk/panel-experiments";

type ExperimentEnvironment = { environmentId: string; env: string };
export type ExperimentEnvironmentCatalog = {
  environment: ExperimentEnvironment;
  items: PanelExperimentListItem[];
};

export type ExperimentEnvironmentResolution =
  | { kind: "experiment"; experimentId: string; experimentKey: string }
  | { kind: "experiment_not_found" }
  | { kind: "experiment_not_in_environment"; experimentKey: string }
  | { kind: "run_not_found"; experimentKey: string }
  | {
      kind: "run_elsewhere";
      env: string;
      experimentId: string;
      experimentKey: string;
      runId: string;
    };

export type ExperimentEnvironmentResolutionInput = {
  appId: string;
  targetEnvironmentId: string;
  experimentRef: string;
  runId?: string;
};

export type ExperimentDetailReader = {
  detail(
    input: PanelExperimentDetailInput,
  ): Promise<ControlPlaneOperationResult<PanelExperimentDetailOutput>>;
};

type Candidate = {
  environment: ExperimentEnvironment;
  experiment: PanelExperimentListItem;
};
type ResolutionResult = ControlPlaneOperationResult<ExperimentEnvironmentResolution>;

export async function resolveExperimentEnvironmentFromCatalogs(
  client: ExperimentDetailReader,
  input: ExperimentEnvironmentResolutionInput,
  catalogs: ExperimentEnvironmentCatalog[],
): Promise<ResolutionResult> {
  const referenced = catalogs.flatMap(({ items }) =>
    items.filter((item) => item.id === input.experimentRef || item.key === input.experimentRef),
  );
  if (referenced.length === 0) return success({ kind: "experiment_not_found" });

  const keys = new Set(referenced.map((item) => item.key));
  if (keys.size !== 1) throw new Error("Experiment route reference resolves to multiple keys");
  const experimentKey = referenced[0]?.key;
  if (!experimentKey) throw new Error("Experiment route reference has no stable key");

  const candidates = catalogs.flatMap(({ environment, items }) =>
    items
      .filter((item) => item.key === experimentKey)
      .map((experiment) => ({ environment, experiment })),
  );
  const target = candidates.find(
    ({ environment }) => environment.environmentId === input.targetEnvironmentId,
  );
  if (!input.runId) {
    return target
      ? success({ kind: "experiment", experimentId: target.experiment.id, experimentKey })
      : success({ kind: "experiment_not_in_environment", experimentKey });
  }
  return resolveRun(client, input.appId, experimentKey, input.runId, candidates);
}

async function resolveRun(
  client: ExperimentDetailReader,
  appId: string,
  experimentKey: string,
  runId: string,
  candidates: Candidate[],
): Promise<ResolutionResult> {
  const details = await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      result: await client.detail({
        appId,
        environmentId: candidate.environment.environmentId,
        experimentId: candidate.experiment.id,
      }),
    })),
  );
  const failure = details.find(({ result }) => !result.ok)?.result;
  if (failure && !failure.ok) return failure;

  const matches = details.filter(({ result }) =>
    result.ok ? result.data.runs.some((run) => run.id === runId) : false,
  );
  if (matches.length === 0) return success({ kind: "run_not_found", experimentKey });
  if (matches.length > 1) throw new Error(`Run ${runId} exists in multiple Environments`);
  const match = matches[0];
  if (!match) throw new Error("Run match disappeared during route resolution");
  return success({
    kind: "run_elsewhere",
    env: match.environment.env,
    experimentId: match.experiment.id,
    experimentKey,
    runId,
  });
}

function success(data: ExperimentEnvironmentResolution): ResolutionResult {
  return { ok: true, status: 200, data };
}
