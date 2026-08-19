import { Field, FieldDescription, FieldError, FieldLabel } from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import { type MetricDraft, type metricDraftIssues, metricIssueFor } from "#lib/metric-form-model";

export function MetricTextField({
  description,
  draft,
  label,
  onEdit,
  path,
  placeholder,
  shown,
  workerError,
}: {
  description?: string;
  draft: MetricDraft;
  label: string;
  onEdit: (patch: Partial<MetricDraft>) => void;
  path: "name" | "key" | "eventDefinitionId" | "eventFieldName";
  placeholder: string;
  shown: ReturnType<typeof metricDraftIssues>;
  workerError?: string;
}) {
  const error = metricIssueFor(shown, path) ?? workerError;
  const id = `metric-${path}`;
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        aria-invalid={Boolean(error)}
        autoComplete="off"
        id={id}
        onChange={(event) => onEdit({ [path]: event.target.value })}
        placeholder={placeholder}
        value={draft[path]}
      />
      {error ? <FieldError>{error}</FieldError> : null}
      {!error && description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}
