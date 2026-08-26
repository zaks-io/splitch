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

type OperandPath = "numeratorMetricId" | "denominatorMetricId";

export function MetricOperandField({
  draft,
  label,
  metrics,
  onEdit,
  path,
  shown,
  workerError,
}: {
  draft: MetricDraft;
  label: string;
  metrics: Metric[];
  onEdit: (patch: Partial<MetricDraft>) => void;
  path: OperandPath;
  shown: ReturnType<typeof metricDraftIssues>;
  workerError?: string;
}) {
  const error = metricIssueFor(shown, path) ?? workerError;
  const inputId = `metric-${path === "numeratorMetricId" ? "numerator" : "denominator"}`;
  return (
    <Field data-disabled={metrics.length < 2} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <Select
        disabled={metrics.length < 2}
        onValueChange={(value) => onEdit({ [path]: value ?? "" })}
        value={draft[path] || null}
      >
        <SelectTrigger aria-invalid={Boolean(error)} className="w-full" id={inputId}>
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
          {metrics.length >= 2
            ? "Ratio operands use each Metric's frozen per-Entity values."
            : "Create two non-Ratio Metrics before defining a Ratio."}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
