import type { PanelExperimentDetailOutput } from "@splitch/control-plane-sdk/panel-experiments";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { Checkbox } from "@splitch/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import { Spinner } from "@splitch/ui/components/spinner";
import { useState } from "react";
import {
  buildMeasurementPatch,
  hasIssue,
  type MeasurementDraft,
  measurementIssues,
} from "#lib/experiments/experiment-draft-model";
import { useExperimentDraftPatch } from "#lib/experiments/use-experiment-draft-patch";

/** Goal Metric family, Guardrail Metrics, Activation Metric, conversion window. */
export function ExperimentDraftMeasurementStep({
  data,
  onSaved,
  scope,
}: {
  data: PanelExperimentDetailOutput;
  onSaved: () => void | Promise<void>;
  scope: { appId: string; environmentId: string };
}) {
  const [draft, setDraft] = useState<MeasurementDraft>({
    metricIds: data.experiment.metricIds,
    guardrailMetricIds: data.experiment.guardrailMetricIds,
    conversionHours: String(data.experiment.conversionWindowMs / 3_600_000),
  });
  const [submitted, setSubmitted] = useState(false);
  const patch = useExperimentDraftPatch(scope, data.experiment.id);
  const issues = measurementIssues(draft);

  function toggle(field: "metricIds" | "guardrailMetricIds", metricId: string) {
    setDraft((current) => {
      const selected = current[field];
      return {
        ...current,
        [field]: selected.includes(metricId)
          ? selected.filter((id) => id !== metricId)
          : [...selected, metricId],
      };
    });
  }

  if (data.metrics.length === 0) {
    return (
      <Alert variant="destructive">
        <AlertTitle>No Metric to decide on</AlertTitle>
        <AlertDescription>
          A Run freezes its goal Metric family at Start, so this App needs at least one Metric
          before Run 1 can be opened.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (hasIssue(issues)) return;
        void patch.save(buildMeasurementPatch(draft), onSaved);
      }}
    >
      <FieldGroup>
        <FieldSet data-invalid={Boolean(submitted && issues.metricIds)}>
          <FieldLegend>Goal Metrics</FieldLegend>
          <FieldDescription>
            The decision family Run 1 freezes. Anything added after Start is exploratory for that
            Run.
          </FieldDescription>
          {data.metrics.map((metric) => (
            <Field data-metric-id={metric.id} key={metric.id} orientation="horizontal">
              <Checkbox
                checked={draft.metricIds.includes(metric.id)}
                id={`goal-metric-${metric.id}`}
                onCheckedChange={() => toggle("metricIds", metric.id)}
              />
              <FieldLabel htmlFor={`goal-metric-${metric.id}`}>{metric.name}</FieldLabel>
            </Field>
          ))}
          <FieldError>{submitted ? issues.metricIds : null}</FieldError>
        </FieldSet>
        <FieldSet data-invalid={Boolean(submitted && issues.guardrailMetricIds)}>
          <FieldLegend>Guardrail Metrics</FieldLegend>
          <FieldDescription>
            Watched for harm rather than for lift. Each Guardrail's downside threshold is defined on
            the Metric itself.
          </FieldDescription>
          {data.metrics.map((metric) => (
            <Field data-metric-id={metric.id} key={metric.id} orientation="horizontal">
              <Checkbox
                checked={draft.guardrailMetricIds.includes(metric.id)}
                id={`guardrail-metric-${metric.id}`}
                onCheckedChange={() => toggle("guardrailMetricIds", metric.id)}
              />
              <FieldLabel htmlFor={`guardrail-metric-${metric.id}`}>{metric.name}</FieldLabel>
            </Field>
          ))}
          <FieldError>{submitted ? issues.guardrailMetricIds : null}</FieldError>
        </FieldSet>
        <Field data-invalid={Boolean(submitted && issues.conversionHours)}>
          <FieldLabel htmlFor="draft-conversion-window">Conversion window (hours)</FieldLabel>
          <Input
            aria-invalid={Boolean(submitted && issues.conversionHours)}
            id="draft-conversion-window"
            min={0}
            onChange={(event) => setDraft((c) => ({ ...c, conversionHours: event.target.value }))}
            step={1}
            type="number"
            value={draft.conversionHours}
          />
          <FieldError>{submitted ? issues.conversionHours : null}</FieldError>
        </Field>
      </FieldGroup>
      {patch.error ? (
        <Alert className="mt-4" variant="destructive">
          <AlertTitle>Step not saved</AlertTitle>
          <AlertDescription>{patch.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6 flex justify-end">
        <Button disabled={patch.isSaving} type="submit">
          {patch.isSaving ? <Spinner data-icon="inline-start" /> : null}
          Save and continue
        </Button>
      </div>
    </form>
  );
}
