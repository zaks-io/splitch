import { renderError } from "@splitch/worker-runtime";

/**
 * Every refusal the attention rollup can return, and the fault type behind the
 * non-retryable one. Split from the handler so the policy it enforces reads in
 * one screen; the wording of each refusal is contract surface, not detail.
 */

export class ExperimentIntegrityError extends Error {
  constructor(readonly experimentId: string) {
    super(`running Experiment ${experimentId} has no live Run`);
    this.name = "ExperimentIntegrityError";
  }
}

/**
 * `runningExperiments` is null when the Environment count alone was already over
 * budget: planning never ran, so no honest count of running Experiments exists.
 */
export function fanoutLimitExceeded(
  details: { appId: string; limit: number; environments: number; runningExperiments?: number },
  requestId: string,
): Response {
  const runningExperiments = details.runningExperiments ?? null;
  const over =
    runningExperiments === null
      ? `${details.environments} Environments`
      : `${runningExperiments} running Experiments`;
  return renderError(
    {
      code: "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      message: `attention rollup spans ${over}, above the ${details.limit} limit; read attention per Environment instead`,
      details: { ...details, runningExperiments, recommendedAction: "READ_PER_ENVIRONMENT" },
    },
    { requestId },
  );
}

/**
 * 500, not 503: the fault is in our own Experiment row and no retry clears it.
 * The message names the Experiment so the requestId-correlated log points at the
 * exact row to repair; the id belongs to the caller's own App.
 */
export function experimentIntegrityFault(
  cause: ExperimentIntegrityError,
  requestId: string,
): Response {
  return renderError(
    {
      code: "INTERNAL_SERVER_ERROR",
      message: `attention rollup found corrupt Experiment state: ${cause.message}`,
      details: {},
    },
    { requestId },
  );
}

export function analysisUnavailable(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "analysis attention data is unavailable",
      details: { retryAfterMs: 30_000 },
    },
    { requestId },
  );
}

export function forbidden(requestId: string): Response {
  return renderError(
    { code: "FORBIDDEN", message: "credential is not allowed for this App", details: {} },
    { requestId },
  );
}
