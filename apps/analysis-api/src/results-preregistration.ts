import type { RunCommitments } from "@splitch/contracts";

/** A legacy Run's token omits the version so it stays byte-identical (ADR-0059). */
export function frozenAnalysisVersion(commitments: RunCommitments): string | null {
  return commitments.analysis_version_source === "frozen" ? commitments.analysis_version : null;
}

/** StatsInput fields bound from frozen Run commitments. */
export function commitmentStatsBindings(commitments: RunCommitments) {
  return {
    analysis_version: commitments.analysis_version,
    ...(commitments.analysis_version_source === "frozen" &&
    commitments.pre_registration !== undefined
      ? { pre_registration: commitments.pre_registration }
      : {}),
  };
}
