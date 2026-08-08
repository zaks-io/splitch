# Decision diagnostics: SRM trend and Dimension auto-cuts

Canonical read contract for diagnosing a blocked Experiment conclusion. These reads never End a Run,
select a Variant, create an Approval Request, or mutate a Flag Configuration.

## Endpoint and request

### `POST /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}/runs/{run_id}/decision-diagnostics`

POST is used because the read has a structured query. The strict body is:

```ts
type DecisionDiagnosticsRequest = {
  expectedResultToken: `sha256:${string}`;
  dataWatermark: string;
  from: string;
  to: string;
  interval: "hour" | "day";
  dimensionIds: string[];
  page: { limit: number; cursor?: string };
};
```

`from` and `to` are ISO 8601 instants with `Run.startedAt <= from < to <= dataWatermark`. The server
does not clamp or default the range. `dimensionIds` is non-empty and every value must be a Dimension
captured before this Run Started; missing, unknown, duplicated, or post-Start exploratory Dimensions
return `VALIDATION_ERROR`. Post-Start Dimensions remain valid for non-decision exploratory output,
but partial capture would make an SRM auto-cut look like a complete-Run diagnostic when it is not.
`limit` is an integer from 1 through 100. Pagination never drops auto-cuts or changes ranking.

The server recomputes the server-owned result at the submitted `dataWatermark`, without advancing or
quantizing it. If a ready envelope's token differs from `expectedResultToken`, it returns
`DECISION_RESULT_STALE` rather than diagnosing different evidence. If recomputation returns
`state: "no_data"` or `state: "no_run"`, it returns `DECISION_RESULT_UNAVAILABLE`; neither state has a
current result token.

## Response

```ts
type DecisionDiagnosticsResponse = {
  runId: string;
  resultToken: `sha256:${string}`;
  dataWatermark: string;
  srmTrend: SrmTrendPoint[];
  autoCuts: SrmDimensionCut[];
  page: { limit: number; nextCursor: string | null };
};

type SrmTrendPoint = {
  bucketEnd: string;
  exposure: SrmSignal;
  activated: SrmSignal | null;
  activationBalance: {
    tier: "clean" | "possible_imbalance" | "confirmed";
    pValue: number | null;
  } | null;
  multipleRate: number;
  multipleCount: number;
};

type SrmSignal = {
  tier: "clean" | "possible_imbalance" | "confirmed";
  pValue: number | null;
  deviations: Array<{
    variant: string;
    observed: number;
    expected: number;
    delta: number;
  }>;
};

type SrmDimensionCut = {
  dimensionId: string;
  dimensionValue: string;
  exposedEntities: number;
  observedCounts: Record<string, number>;
  expectedCounts: Record<string, number>;
  srmPValue: number;
  srmIsMismatch: boolean;
  chiSquareContribution: number;
  absoluteDeviation: number;
  rank: number;
};
```

Each trend point is cumulative from `from` through its exclusive `bucketEnd`; this shows whether a
mismatch persisted instead of turning disjoint low-volume buckets into false reassurance. The last
point ends exactly at `to`. Full-exposed and activated SRM use the canonical chi-square rules. The
Stats engine's mismatch boolean is authoritative; `p < 0.001` is only the shipped gate's fallback
when that boolean is absent, so this read never reimplements the threshold. Activation members are
null only when the Run has no Activation Metric.

`SrmSignal` is the shipped signal shape; it has no `observedCounts` or `expectedCounts` members. The
activated signal carries `deviations: []` because `SrmResultSchema` does not surface the Stats
engine's activated counts today. Per-Variant activated observed and expected counts are a named
result-contract gap; this read does not invent them.

Auto-cuts cover the complete `[from, to)` range. For each requested Dimension value, observed counts
are first-touch unique Entities by Variant, excluding `__multiple__`; expected counts come from the
Run's frozen allocation. `chiSquareContribution` is the sum of `(observed - expected)^2 / expected`
across Variants. `absoluteDeviation` is the sum of `abs(observed - expected)` across Variants.

The canonical order is confirmed mismatch first, ascending `srmPValue`, descending
`chiSquareContribution`, descending `absoluteDeviation`, then `dimensionId` and `dimensionValue`
lexicographically. `rank` is one-based over the complete ordered set and remains stable across pages.
The cursor encodes the last complete sort tuple plus the bound result token and data watermark; a
cursor reused with different evidence returns `DECISION_RESULT_STALE`.

These are diagnostic slices only. They never enter the Run's BH family, change `decision_valid`, or
independently authorize conclusion.

## Tenant and provenance boundary

The Analysis Worker receives App, Environment, Experiment, and Run identity from the authenticated
path. It looks up the Run by the full composite scope and injects `app_id`, `environment_id`, and
`run_id` into every Tinybird query. The body cannot override any scope. A missing or cross-scope
identifier uses the existing non-revealing `RUN_NOT_FOUND`; no diagnostic rows from another App or
Environment are returned.

All reads use the request's inclusive `ingest_ts <= dataWatermark` boundary and the same deduped
Exposure source as Results. The watermark is the inclusive Copy Pipe boundary, so exact-equality rows
remain in the evidence set. Raw Targeting Keys are never returned. Dimension values are the declared,
allowlisted values captured by the Run, not free-form Entity data.

## Sources

- [srm-and-health.md](srm-and-health.md)
- [dimension-slicing.md](dimension-slicing.md)
- [result-contracts.md](result-contracts.md)
- [../pipeline/dedup-query-contract.md](../pipeline/dedup-query-contract.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
