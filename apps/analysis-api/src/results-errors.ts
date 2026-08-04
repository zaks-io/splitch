/**
 * The refusals a Results read can raise, kept as types so the response layer
 * can tell a transient fault from a permanent integrity failure or a named
 * missing input.
 */

export class ResultsNotFoundError extends Error {
  constructor(readonly code: "EXPERIMENT_NOT_FOUND" | "RUN_NOT_FOUND") {
    super(code === "RUN_NOT_FOUND" ? "Experiment Run not found" : "Experiment not found");
    this.name = "ResultsNotFoundError";
  }
}

export class ResultsForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultsForbiddenError";
  }
}

/** The inputs pipe answered for a Run other than the one that was asked for. */
export class AnalysisProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisProvenanceError";
  }
}

export class AnalysisIsolationError extends Error {
  constructor() {
    super("Tinybird returned a row outside the requested App/Environment scope");
    this.name = "AnalysisIsolationError";
  }
}

/**
 * A locked Run is readable but missing an analysis input the caller needs to
 * distinguish from an upstream break (SPL-302).
 */
export class ResultsInsufficientDataError extends Error {
  constructor(readonly missing: "exposures" | "metric_events") {
    super(missing === "exposures" ? "no Exposures for this Run" : "no Metric Events for this Run");
    this.name = "ResultsInsufficientDataError";
  }
}

/** A Run Snapshot field could not be materialized into StatsInput. */
export class ResultsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultsInputError";
  }
}
