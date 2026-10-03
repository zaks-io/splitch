import {
  ANALYSIS_V2_VERSION,
  AnalysisResultsEnvelopeSchema,
  type ExperimentResultsResponse,
  type ExperimentResultsView,
  ExperimentResultsViewSchema,
  type PersistedSrmAlarm,
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

export async function enrichAnalysisResultsResponse(
  repo: Repository,
  analysisBody: unknown,
  run: {
    id: string;
    appId: string;
    environmentId: string;
    runNumber: number;
    status: string;
    controlVariantId: string;
    variantSet: string;
    startedAt: string;
    plannedDurationDays: number | null;
    plannedDurationOverrideReason: string | null;
    analysisVersion: string | null;
  },
  options: {
    view: ExperimentResultsView;
    canConclude: boolean;
    includeExploratory?: boolean;
  },
): Promise<ExperimentResultsResponse> {
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
  const persistedSrmAlarms =
    analysis.state === "ready"
      ? await syncAnalysisV2SrmAlarms(repo, run, analysis.stats, dataWatermark)
      : [];
  const cohortEffect = analysis.state === "ready" ? (analysis.cohort_effect ?? null) : null;
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
    persistedSrmAlarms,
    cohortEffect,
    includeExploratory: options.includeExploratory === true,
  });
}

/** A sequential crossing without a real Analysis watermark must not invent one. */
export class SrmAlarmWatermarkRequiredError extends Error {
  constructor() {
    super(
      "analysis-v2 sequential SRM crossing reported without data_watermark; refuse to invent an evidence boundary",
    );
    this.name = "SrmAlarmWatermarkRequiredError";
  }
}

type SrmAlarmStats = {
  srm: {
    srm_is_mismatch: boolean;
    srm_p_value: number;
    activated_srm_mismatch: boolean | null;
    activated_srm_p_value: number | null;
    srm_sequential_threshold_crossed?: boolean;
    activated_srm_sequential_threshold_crossed?: boolean | null;
  };
};

function assertSequentialCrossingFlags(srm: SrmAlarmStats["srm"]): void {
  if (
    srm.srm_sequential_threshold_crossed !== true &&
    srm.srm_sequential_threshold_crossed !== false
  ) {
    throw new Error(
      "analysis-v2 Results omit srm_sequential_threshold_crossed; refuse to persist SRM alarms",
    );
  }
  if (
    srm.activated_srm_mismatch !== null &&
    srm.activated_srm_sequential_threshold_crossed !== true &&
    srm.activated_srm_sequential_threshold_crossed !== false
  ) {
    throw new Error(
      "analysis-v2 Results omit activated_srm_sequential_threshold_crossed; refuse to persist SRM alarms",
    );
  }
}

/** Persist only genuine sequential crossings; never invent a watermark. */
async function persistSequentialCrossings(
  repo: Repository,
  run: { id: string; appId: string; environmentId: string },
  srm: SrmAlarmStats["srm"],
  dataWatermark: string | undefined,
  now: string,
): Promise<void> {
  const exposureCrossed = srm.srm_sequential_threshold_crossed === true;
  const activatedCrossed = srm.activated_srm_sequential_threshold_crossed === true;
  if (!exposureCrossed && !activatedCrossed) return;
  if (dataWatermark === undefined) throw new SrmAlarmWatermarkRequiredError();
  const scope = envScope(run.appId, run.environmentId);
  if (exposureCrossed) {
    await repo.runSrmAlarms.insertIgnore(scope, {
      runId: run.id,
      srmKind: "exposure",
      firstCrossedAt: now,
      watermark: dataWatermark,
      pValue: srm.srm_p_value,
      analysisVersion: ANALYSIS_V2_VERSION,
    });
  }
  if (activatedCrossed) {
    await repo.runSrmAlarms.insertIgnore(scope, {
      runId: run.id,
      srmKind: "activated",
      firstCrossedAt: now,
      watermark: dataWatermark,
      pValue: srm.activated_srm_p_value ?? 0,
      analysisVersion: ANALYSIS_V2_VERSION,
    });
  }
}

/**
 * For analysis-v2 only: INSERT OR IGNORE on live sequential crossings, then
 * return every persisted alarm for the Run so the gate ORs them in.
 */
export async function syncAnalysisV2SrmAlarms(
  repo: Repository,
  run: {
    id: string;
    appId: string;
    environmentId: string;
    analysisVersion: string | null;
  },
  stats: SrmAlarmStats,
  dataWatermark: string | undefined,
): Promise<readonly PersistedSrmAlarm[]> {
  if (run.analysisVersion !== ANALYSIS_V2_VERSION) return [];
  assertSequentialCrossingFlags(stats.srm);
  await persistSequentialCrossings(repo, run, stats.srm, dataWatermark, new Date().toISOString());
  const rows = await repo.runSrmAlarms.listForRun(envScope(run.appId, run.environmentId), run.id);
  return rows.map((row) => ({
    srmKind: row.srmKind,
    firstCrossedAt: row.firstCrossedAt,
    pValue: row.pValue,
  }));
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
