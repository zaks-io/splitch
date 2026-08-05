import {
  DEFAULT_CUPED_COVERAGE_THRESHOLD_PCT,
  DEFAULT_WINSORIZE,
  DEFAULT_WINSORIZE_PCT,
  type GuardrailDecision,
  type MetricRef,
  type MetricVarianceConfig,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { experimentStartInvalid } from "./experiment-errors";

type MetricRow = NonNullable<Awaited<ReturnType<Repository["experiments"]["getMetric"]>>>;
type Result<T> = { ok: true; value: T } | { ok: false; response: Response };

export interface FrozenAnalysisConfig {
  guardrailDecisions: GuardrailDecision[];
  metricVarianceConfig: MetricVarianceConfig[];
}

/**
 * Resolve the per-Metric analysis rules once, at Start, for the Run to freeze.
 * Reading them from the Metric rows at analysis time instead would let a Metric
 * edited mid-Run restate an already-decided result (variance-reduction.md,
 * ADR-0016), and until this existed the guardrail thresholds never reached the
 * engine at all, so every guardrail check passed by default.
 *
 * Guardrails expand per treatment Variant because a GuardrailDecision is per
 * (Metric, Variant): the Control arm is the comparison baseline, not a subject
 * of the check.
 */
export async function frozenAnalysisConfig(
  repo: Repository,
  appId: string,
  refs: { metrics: MetricRef[]; guardrailMetrics: MetricRef[] },
  treatments: string[],
  requestId: string,
): Promise<Result<FrozenAnalysisConfig>> {
  const guardrailIds = uniqueIds(refs.guardrailMetrics);
  const analyzedIds = uniqueIds([...refs.metrics, ...refs.guardrailMetrics]);
  const rows = await loadMetrics(repo, appId, analyzedIds);

  const bounded: Array<{ metricId: string; threshold: number }> = [];
  const unbounded: string[] = [];
  for (const metricId of guardrailIds) {
    const threshold = rows.get(metricId)?.downsideThresholdPct;
    if (typeof threshold === "number") bounded.push({ metricId, threshold });
    else unbounded.push(metricId);
  }
  if (unbounded.length > 0) {
    return {
      ok: false,
      response: experimentStartInvalid(
        unbounded.map((metricId) => ({
          path: ["body", "guardrailMetrics", metricId],
          message: `guardrail Metric ${metricId} has no downsideThresholdPct, so no result could ever breach it. PATCH the Metric with a downsideThresholdPct, then Start.`,
        })),
        requestId,
      ),
    };
  }
  if (bounded.length > 0 && treatments.length === 0) {
    return {
      ok: false,
      response: experimentStartInvalid(
        [
          {
            path: ["body", "allocation"],
            message:
              "guardrail Metrics are checked per treatment Variant, and this allocation has none besides the Control Variant. Allocate a treatment Variant, or drop the guardrail Metrics.",
          },
        ],
        requestId,
      ),
    };
  }

  return {
    ok: true,
    value: {
      guardrailDecisions: bounded.flatMap(({ metricId, threshold }) =>
        treatments.map((variant) => ({
          metric_id: metricId,
          variant,
          downside_threshold_pct: threshold,
          guardrail_locked_at_run_start: true,
          threshold_locked_at_run_start: true,
        })),
      ),
      metricVarianceConfig: analyzedIds.map((metricId) => varianceConfig(rows, metricId)),
    },
  };
}

async function loadMetrics(
  repo: Repository,
  appId: string,
  metricIds: string[],
): Promise<Map<string, MetricRow>> {
  const scope = appScope(appId);
  const rows = new Map<string, MetricRow>();
  for (const metricId of metricIds) {
    const row = await repo.experiments.getMetric(scope, metricId);
    // validateMetricRefs already proved every ref resolves, so a miss here means
    // the Metric was deleted between that read and this one.
    if (!row) {
      throw new Error(`prepareStart: Metric ${metricId} disappeared between validation and freeze`);
    }
    rows.set(metricId, row);
  }
  return rows;
}

/**
 * A null knob on the Metric means "no preference". The Run states every knob
 * explicitly, because the point of freezing is that a re-analysis reproduces the
 * original numbers without consulting a Metric row that may have been edited
 * since, and "unset" would resolve against whatever the engine defaults to then.
 */
function varianceConfig(rows: Map<string, MetricRow>, metricId: string): MetricVarianceConfig {
  const row = rows.get(metricId);
  if (!row) throw new Error(`prepareStart: Metric ${metricId} was not loaded`);
  return {
    metric_id: metricId,
    winsorize: row.kind === "binomial" ? false : (row.winsorize ?? DEFAULT_WINSORIZE),
    winsorize_pct: row.winsorizePct ?? DEFAULT_WINSORIZE_PCT,
    cuped_coverage_threshold_pct:
      row.cupedCoverageThresholdPct ?? DEFAULT_CUPED_COVERAGE_THRESHOLD_PCT,
  };
}

function uniqueIds(refs: MetricRef[]): string[] {
  return [...new Set(refs.map((ref) => ref.metricId))];
}
