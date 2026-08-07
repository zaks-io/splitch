# Decision diagnostics: SRM trend and Dimension auto-cuts

Canonical read contract for diagnosing a blocked Experiment conclusion. These reads never End a Run,
select a Variant, create an Approval Request, or mutate a Flag Configuration.

## Endpoint and request

### `POST /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}/runs/{run_id}/decision-diagnostics`

POST is used because the read has a structured query. The strict body is:

```ts
type DecisionDiagnosticsRequest = {
  expectedResultToken: `sha256:${string}`;
  from: string;
  to: string;
  interval: "hour" | "day";
  dimensionIds: string[];
  page: { limit: number; cursor?: string };
};
```

`from` and `to` are ISO 8601 instants with `Run.startedAt <= from < to <= dataWatermark`. The server
does not clamp or default the range. `dimensionIds` is non-empty and every value must be a Dimension
captured for the Run; missing, unknown, duplicated, or post-Start exploratory Dimensions return
`VALIDATION_ERROR`. `limit` is an integer from 1 through 100. Pagination never drops auto-cuts or
changes ranking.

The server re-reads the current server-owned result. If its token differs from
`expectedResultToken`, it returns `DECISION_RESULT_STALE` rather than diagnosing different evidence.

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
    pValue: number;
    isMismatch: boolean;
    rates: Record<string, number>;
  } | null;
  multipleRate: number;
  multipleCount: number;
};

type SrmSignal = {
  pValue: number;
  isMismatch: boolean;
  observedCounts: Record<string, number>;
  expectedCounts: Record<string, number>;
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
point ends exactly at `to`. Full-exposed and activated SRM use the canonical chi-square rules and the
Stats engine's `p < 0.001` mismatch verdict. Activation members are null only when the Run has no
Activation Metric.

Auto-cuts cover the complete `[from, to)` range. For each requested Dimension value, observed counts
are first-touch unique Entities by Variant, excluding `__multiple__`; expected counts come from the
Run's frozen allocation. `chiSquareContribution` is the sum of `(observed - expected)^2 / expected`
across Variants. `absoluteDeviation` is the sum of `abs(observed - expected)` across Variants.

The canonical order is confirmed mismatch first, ascending `srmPValue`, descending
`chiSquareContribution`, descending `absoluteDeviation`, then `dimensionId` and `dimensionValue`
lexicographically. `rank` is one-based over the complete ordered set and remains stable across pages.
The cursor encodes the last complete sort tuple plus the bound result token; a cursor reused after the
result changes returns `DECISION_RESULT_STALE`.

These are diagnostic slices only. They never enter the Run's BH family, change `decision_valid`, or
independently authorize conclusion.

## Tenant and provenance boundary

The Analysis Worker receives App, Environment, Experiment, and Run identity from the authenticated
path. It looks up the Run by the full composite scope and injects `app_id`, `environment_id`, and
`run_id` into every Tinybird query. The body cannot override any scope. A missing or cross-scope
identifier uses the existing non-revealing `RUN_NOT_FOUND`; no diagnostic rows from another App or
Environment are returned.

All reads use the same half-open `ingest_ts < dataWatermark` boundary and the same deduped Exposure
source as Results. Raw Targeting Keys are never returned. Dimension values are the declared,
allowlisted values captured by the Run, not free-form Entity data.

## Sources

- [srm-and-health.md](srm-and-health.md)
- [dimension-slicing.md](dimension-slicing.md)
- [result-contracts.md](result-contracts.md)
- [../pipeline/dedup-query-contract.md](../pipeline/dedup-query-contract.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
