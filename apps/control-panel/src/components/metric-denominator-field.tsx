import type { Metric } from "@splitch/contracts";
import { Field, FieldDescription, FieldError, FieldLabel } from "@splitch/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { type MetricDraft, type metricDraftIssues, metricIssueFor } from "#lib/metric-form-model";

export function MetricDenominatorField({
  draft,
  metrics,
  onEdit,
  shown,
  workerError,
}: {
  draft: MetricDraft;
  metrics: Metric[];
  onEdit: (patch: Partial<MetricDraft>) => void;
  shown: ReturnType<typeof metricDraftIssues>;
  workerError?: string;
}) {
  const error = metricIssueFor(shown, "denominatorMetricId") ?? workerError;
  return (
    <Field data-disabled={metrics.length === 0} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor="metric-denominator">Denominator Metric</FieldLabel>
      <Select
        disabled={metrics.length === 0}
        onValueChange={(value) => onEdit({ denominatorMetricId: value ?? "" })}
        value={draft.denominatorMetricId || null}
      >
        <SelectTrigger aria-invalid={Boolean(error)} className="w-full" id="metric-denominator">
          <SelectValue placeholder="Choose a Metric" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {metrics.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? <FieldError>{error}</FieldError> : null}
      {!error ? (
        <FieldDescription>
          {metrics.length > 0
            ? "The numerator event total is divided by this App-level Metric."
            : "Create another Metric before defining a Ratio."}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
