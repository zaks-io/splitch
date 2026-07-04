import type { EnvScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound } from "./app-environment-model";
import { experimentAlreadyRunningForFlag } from "./experiment-errors";
import {
  blockingRunningExperimentForStart,
  optionalBody,
  requireWritableEnvironment,
  type ExperimentDeps,
} from "./experiment-handler-shared";
import type { ExperimentRow } from "./experiment-model";
import { confirmationRequired, readEnvironmentPolicy } from "./flag-config-policy";

export async function validateStartRequest(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  scope: EnvScope,
  experiment: ExperimentRow,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const writeError = await requireWritableEnvironment(
    deps,
    scope,
    args.principal.id,
    args.requestId,
  );
  if (writeError) return { ok: false, response: writeError };

  const body = optionalBody(args.input);
  const policy = await readEnvironmentPolicy(deps.repo, scope.appId, scope.environmentId);
  if (!policy) return { ok: false, response: appNotFound(args.requestId) };
  const confirmation = confirmationRequired(
    policy,
    ["start_experiment_run"],
    body.confirm === true,
    scope.environmentId,
    "START_EXPERIMENT_RUN",
    args.requestId,
  );
  if (confirmation) return { ok: false, response: confirmation };

  const runningBlocker = await blockingRunningExperimentForStart(deps.repo, scope, experiment);
  if (!runningBlocker) return { ok: true, body };
  return {
    ok: false,
    response: experimentAlreadyRunningForFlag(
      runningBlocker.experimentId,
      runningBlocker.runId,
      args.requestId,
    ),
  };
}
