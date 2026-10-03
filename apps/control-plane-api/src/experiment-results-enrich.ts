import {
  AnalysisResultsEnvelopeSchema,
  type ExperimentResultsResponse,
  type ExperimentResultsView,
  ExperimentResultsViewSchema,
  produceExperimentResults,
  resolveAnalysisControlIntegrity,
  resolveFrozenControlIdentity,
} from "@splitch/contracts";
import { envScope, type Repository } from "@splitch/db";
import { classifySrmRootCauseFromStats } from "@splitch/stats";
import { runDurationEvidence } from "./run-duration-evidence";

const CONCLUDE_ROLES = new Set(["owner", "admin"]);

export function resultsViewFromParts(parts: {
  query?: Record<string, unknown>;
  body?: unknown;
}): ExperimentResultsView {
  const raw =
    typeof parts.query?.view === "string"
      ? parts.query.view
      : isRecord(parts.body) && typeof parts.body.view === "string"
        ? parts.body.view
        : undefined;
  if (raw === undefined) return "detailed";
  return ExperimentResultsViewSchema.parse(raw);
}

export function includeExploratoryFromParts(parts: {
  query?: Record<string, unknown>;
  body?: unknown;
}): boolean {
  const raw =
    typeof parts.query?.includeExploratory === "boolean"
      ? parts.query.includeExploratory
      : isRecord(parts.body) && typeof parts.body.includeExploratory === "boolean"
        ? parts.body.includeExploratory
        : false;
  return raw;
}

/** Strip skin-only selectors before the Analysis hop. */
export function analysisHopParts(parts: {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}): {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
} {
  return {
    ...(parts.params !== undefined ? { params: parts.params } : {}),
    ...(parts.query !== undefined ? { query: withoutSkinSelectors(parts.query) } : {}),
    ...(parts.body !== undefined
      ? { body: isRecord(parts.body) ? withoutSkinSelectors(parts.body) : parts.body }
      : {}),
  };
}

export function canConcludeWithRole(role: string | null | undefined): boolean {
  return role !== null && role !== undefined && CONCLUDE_ROLES.has(role);
}

export async function loadResultsRun(
  repo: Repository,
  args: { appId: string; environmentId: string; runId: string },
) {
  return repo.experiments.getRun(envScope(args.appId, args.environmentId), args.runId);
}

export function enrichAnalysisResultsResponse(
  analysisBody: unknown,
  run: {
    id: string;
    runNumber: number;
    status: string;
    controlVariantId: string;
    variantSet: string;
    startedAt: string;
    plannedDurationDays: number | null;
    plannedDurationOverrideReason: string | null;
  },
  options: {
    view: ExperimentResultsView;
    canConclude: boolean;
    includeExploratory?: boolean;
  },
): ExperimentResultsResponse {
  const analysis = AnalysisResultsEnvelopeSchema.parse(analysisBody);
  // Callers only reach enrich after D1 resolved a Run. Analysis no_run here is a
  // contract violation (drafts are finished before the hop); masking it as
  // START_A_RUN would tell clients the Experiment never started.
  if (analysis.state === "no_run") {
    throw new Error(
      "analysis answered no_run; Control Plane resolves draft Experiments before the hop",
    );
  }
  if (analysis.run_id !== run.id) {
    throw new Error(`analysis answered for Run ${analysis.run_id}, not Run ${run.id}`);
  }
  const control = resolveAnalysisControlIntegrity(
    resolveFrozenControlIdentity(run.controlVariantId, run.variantSet),
    analysis.control_variant,
  );
  const dataWatermark = analysis.state === "ready" ? analysis.data_watermark : undefined;
  // Classifier is Control Plane-only: it must not touch Analysis stats or the
  // result token. Segment/day slices are absent until decision-diagnostics is wired.
  const srmRootCause =
    analysis.state === "ready" ? classifySrmRootCauseFromStats(analysis.stats) : null;
  return produceExperimentResults({
    view: options.view,
    analysis,
    run: {
      runNumber: run.runNumber,
      runStatus: run.status === "ended" ? "ended" : "running",
      control,
      duration: runDurationEvidence(run, dataWatermark),
    },
    canConclude: options.canConclude,
    srmRootCause,
    includeExploratory: options.includeExploratory === true,
  });
}

export function produceNoRunResults(view: ExperimentResultsView): ExperimentResultsResponse {
  return produceExperimentResults({
    view,
    analysis: { state: "no_run", recommended_action: "START_A_RUN" },
    run: null,
    canConclude: false,
  });
}

function withoutSkinSelectors(record: Record<string, unknown>): Record<string, unknown> {
  const { view: _view, includeExploratory: _exploratory, ...rest } = record;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
