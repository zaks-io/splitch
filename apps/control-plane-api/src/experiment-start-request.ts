import type { EnvScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { experimentAlreadyRunningForFlag } from "./experiment-errors";
import {
  blockingRunningExperimentForStart,
  type ExperimentDeps,
  optionalBody,
  requireWritableEnvironment,
} from "./experiment-handler-shared";
import type { ExperimentRow } from "./experiment-model";

export async function validateStartRequest(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  scope: EnvScope,
  experiment: ExperimentRow,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const writeError = await requireWritableEnvironment(deps, scope, args.principal, args.requestId);
  if (writeError) return { ok: false, response: writeError };

  const body = optionalBody(args.input);
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
