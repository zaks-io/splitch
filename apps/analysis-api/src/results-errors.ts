/**
 * The refusals a Results read can raise, kept as types so the response layer
 * can tell a transient fault from a permanent integrity failure.
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
