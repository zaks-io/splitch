import type { Metric } from "@splitch/contracts";
import type { MutationErrorSurface } from "#lib/api";
import type { MetricDraft, metricDraftIssues } from "#lib/metric-form-model";
import { MetricAggregationField } from "./metric-aggregation-field";
import { MetricOperandField } from "./metric-operand-field";
import { MetricTextField } from "./metric-text-field";
import { workerMetricFieldError } from "./use-metric-form";

export function MetricFactFields({
  ratioOperandMetrics,
  draft,
  edit,
  editing,
  mutationError,
  shown,
}: {
  ratioOperandMetrics: Metric[];
  draft: MetricDraft;
  edit: (patch: Partial<MetricDraft>) => void;
  editing: boolean;
  mutationError: MutationErrorSurface | null;
  shown: ReturnType<typeof metricDraftIssues>;
}) {
  return (
    <>
      <MetricAggregationField
        draft={draft}
        editing={editing}
        hasDenominatorCandidates={ratioOperandMetrics.length >= 2}
        onEdit={edit}
      />
      {draft.kind !== "ratio" ? (
        <MetricTextField
          description="The exact event type matched in the Metric Event stream."
          draft={draft}
          label="Event name"
          onEdit={edit}
          path="eventDefinitionId"
          placeholder="checkout_completed"
          shown={shown}
          workerError={workerMetricFieldError(mutationError, "eventDefinitionId")}
        />
      ) : null}
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
          path="eventFieldName"
          placeholder={draft.kind === "revenue" ? "amount" : "quantity"}
          shown={shown}
          workerError={workerMetricFieldError(mutationError, "eventFieldName")}
        />
      ) : null}
      {draft.kind === "ratio" ? (
        <>
          <MetricOperandField
            draft={draft}
            label="Numerator Metric"
            metrics={ratioOperandMetrics}
            onEdit={edit}
            path="numeratorMetricId"
            shown={shown}
            workerError={workerMetricFieldError(mutationError, "numerator")}
          />
          <MetricOperandField
            draft={draft}
            label="Denominator Metric"
            metrics={ratioOperandMetrics}
            onEdit={edit}
            path="denominatorMetricId"
            shown={shown}
            workerError={workerMetricFieldError(mutationError, "denominator")}
          />
        </>
      ) : null}
    </>
  );
}
