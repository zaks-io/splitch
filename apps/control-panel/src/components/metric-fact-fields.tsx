import type { Metric } from "@splitch/contracts";
import type { MutationErrorSurface } from "#lib/api";
import type { MetricDraft, metricDraftIssues } from "#lib/metric-form-model";
import { MetricAggregationField } from "./metric-aggregation-field";
import { MetricDenominatorField } from "./metric-denominator-field";
import { MetricTextField } from "./metric-text-field";
import { workerMetricFieldError } from "./use-metric-form";

export function MetricFactFields({
  denominatorMetrics,
  draft,
  edit,
  editing,
  mutationError,
  shown,
}: {
  denominatorMetrics: Metric[];
  draft: MetricDraft;
  edit: (patch: Partial<MetricDraft>) => void;
  editing: boolean;
  mutationError: MutationErrorSurface | null;
  shown: ReturnType<typeof metricDraftIssues>;
}) {
  return (
    <>
      <MetricAggregationField draft={draft} editing={editing} onEdit={edit} />
      <MetricTextField
        description="The exact event type matched in the Metric Event stream."
        draft={draft}
        label={draft.kind === "ratio" ? "Numerator event name" : "Event name"}
        onEdit={edit}
        path="eventName"
        placeholder="checkout_completed"
        shown={shown}
        workerError={workerMetricFieldError(mutationError, "eventName")}
      />
      {draft.kind === "count" || draft.kind === "revenue" ? (
        <MetricTextField
          description={
            draft.kind === "revenue"
              ? "Numeric event field summed as revenue per Entity."
              : "Numeric event field summed as a count per Entity."
          }
          draft={draft}
          label="Event value field"
          onEdit={edit}
          path="eventValueField"
          placeholder={draft.kind === "revenue" ? "amount" : "quantity"}
          shown={shown}
          workerError={workerMetricFieldError(mutationError, "eventValueField")}
        />
      ) : null}
      {draft.kind === "ratio" ? (
        <MetricDenominatorField
          draft={draft}
          metrics={denominatorMetrics}
          onEdit={edit}
          shown={shown}
          workerError={workerMetricFieldError(mutationError, "denominator")}
        />
      ) : null}
    </>
  );
}
