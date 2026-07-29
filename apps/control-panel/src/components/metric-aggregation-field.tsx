import type { MetricKind } from "@splitch/contracts";
import { Field, FieldDescription, FieldLabel } from "@splitch/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { METRIC_KINDS, type MetricDraft } from "#lib/metric-form-model";

export function MetricAggregationField({
  draft,
  editing,
  onEdit,
}: {
  draft: MetricDraft;
  editing: boolean;
  onEdit: (patch: Partial<MetricDraft>) => void;
}) {
  return (
    <Field data-disabled={editing}>
      <FieldLabel htmlFor="metric-kind">Aggregation type</FieldLabel>
      <Select
        disabled={editing}
        onValueChange={(value) => onEdit(kindPatch(value as MetricKind))}
        value={draft.kind}
      >
        <SelectTrigger className="w-full" id="metric-kind">
          <SelectValue placeholder="Choose an aggregation type" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {METRIC_KINDS.map(({ kind, label }) => (
              <SelectItem key={kind} value={kind}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>
        {editing
          ? "Aggregation type is immutable after this Metric is created."
          : aggregationDescription(draft.kind)}
      </FieldDescription>
    </Field>
  );
}

function kindPatch(kind: MetricKind): Partial<MetricDraft> {
  return {
    kind,
    eventValueField: "",
    denominatorMetricId: "",
  };
}

function aggregationDescription(kind: MetricKind): string {
  switch (kind) {
    case "binomial":
      return "Whether each Entity produced the matching event.";
    case "count":
      return "A numeric event field summed per Entity.";
    case "revenue":
      return "A monetary event field summed per Entity.";
    case "ratio":
      return "The matching numerator events divided by another Metric.";
  }
}
