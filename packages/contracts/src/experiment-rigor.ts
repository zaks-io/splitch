// The rigor surface a Results reader needs: the ship-decision gate, the SRM
// diagnostics behind it, the Worker-computed significance display state, the
// shared Control Plane result producer, and the one p-value rendering rule they
// all cite. Grouped here so the package entry point exposes it as a single concept.
// biome-ignore lint/performance/noBarrelFile lint/performance/noReExportAll: each source module owns one part of a cohesive rigor surface
export * from "./experiment-control-identity";
// biome-ignore lint/performance/noReExportAll: each source module owns one part of a cohesive rigor surface
export * from "./experiment-decision-family";
// biome-ignore lint/performance/noReExportAll: each source module owns one part of a cohesive rigor surface
export * from "./experiment-decision-gate";
export {
  earliestDecisionWatermark,
  observedEvidenceDays,
  type PlannedDurationEvidence,
} from "./experiment-decision-gate-duration";
// biome-ignore lint/performance/noReExportAll: each source module owns one part of a cohesive rigor surface
export * from "./experiment-results-producer";
// biome-ignore lint/performance/noReExportAll: each source module owns one part of a cohesive rigor surface
export * from "./experiment-results-readiness";
// biome-ignore lint/performance/noReExportAll: each source module owns one part of a cohesive rigor surface
export * from "./experiment-results-response";
// biome-ignore lint/performance/noReExportAll: each source module owns one part of a cohesive rigor surface
export * from "./experiment-significance-display";
// biome-ignore lint/performance/noReExportAll: each source module owns one part of a cohesive rigor surface
export * from "./p-value-format";
// biome-ignore lint/performance/noReExportAll: each source module owns one part of a cohesive rigor surface
export * from "./srm-root-cause";
