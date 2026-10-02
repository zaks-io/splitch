import {
  LEGACY_RUN_COMMITMENTS,
  type RunCommitments,
  RunCommitmentsSchema,
  SUPPORTED_ANALYSIS_VERSIONS,
} from "@splitch/contracts";
import { ResultsInputError } from "./results-errors";
import { rowObject } from "./results-row-fields";

const COMMITMENT_FIELDS = [
  "analysis_version",
  "target_n",
  "target_n_source",
  "planned_duration_days",
  "planned_duration_override_reason",
] as const;

/**
 * Read what the Run committed to at Start from its Run Snapshot (ADR-0059).
 *
 * A snapshot with no `analysis_version` is a legacy Run: it is read under the
 * labeled legacy version and reports no target or duration commitment, because
 * it never recorded one. A version this deployment does not implement is
 * refused rather than analyzed under a different engine, which is what keeps a
 * rollback from silently re-deciding a Run started on a newer version.
 */
export function materializeRunCommitments(row: unknown): RunCommitments {
  const source = rowObject(row);
  // An absent column means the pipe did not select it, which is not the same
  // fact as a legacy Run's null. Reading it as legacy would drop the version
  // from a versioned Run's token.
  const missing = COMMITMENT_FIELDS.filter((field) => !(field in source));
  if (missing.length > 0) {
    throw new ResultsInputError(`analysis_run_inputs omitted ${missing.join(", ")}`);
  }
  const version = source.analysis_version;
  if (version === null) return LEGACY_RUN_COMMITMENTS;
  if (typeof version !== "string" || !SUPPORTED_ANALYSIS_VERSIONS.includes(version)) {
    throw new ResultsInputError(
      `Run froze analysis_version ${String(version)}, which this Analysis deployment does not implement (supported: ${SUPPORTED_ANALYSIS_VERSIONS.join(", ")})`,
    );
  }
  const parsed = RunCommitmentsSchema.safeParse({
    analysis_version_source: "frozen",
    analysis_version: version,
    target_n: source.target_n,
    target_n_source: source.target_n_source,
    planned_duration_days: source.planned_duration_days,
    planned_duration_override_reason: source.planned_duration_override_reason,
  });
  if (!parsed.success) {
    throw new ResultsInputError(
      `Run commitments are invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    );
  }
  if ((parsed.data.target_n === null) !== (parsed.data.target_n_source === null)) {
    throw new ResultsInputError("Run commitments pair target_n with target_n_source");
  }
  return parsed.data;
}
