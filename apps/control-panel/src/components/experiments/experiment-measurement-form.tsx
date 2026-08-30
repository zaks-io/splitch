import type {
  PanelExperimentDetail,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
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
import { type FormEvent, useState } from "react";
import { updateControlPanelExperiment } from "#lib/experiments/control-plane-experiment-functions";
import { useExperimentDetailRefresh } from "#lib/experiments/use-experiment-detail-refresh";

type MetricOption = { id: string; name: string };

export function ExperimentMeasurementForm({
  appId,
  environmentId,
  experiment,
  liveRun,
  metrics,
}: {
  appId: string;
  environmentId: string;
  experiment: PanelExperimentDetail;
  liveRun: PanelExperimentRun | undefined;
  metrics: MetricOption[];
}) {
  const refresh = useExperimentDetailRefresh({ appId, environmentId }, experiment.id);
  const decisionMetrics = new Set(liveRun?.decisionMetricIds ?? []);
  const decisionGuardrails = new Set(liveRun?.decisionGuardrailMetricIds ?? []);
  const [conversionHours, setConversionHours] = useState(experiment.conversionWindowMs / 3_600_000);
  const [secondary, setSecondary] = useState(() =>
    experiment.metricIds.filter((id) => !decisionMetrics.has(id)),
  );
  const [guardrails, setGuardrails] = useState(() =>
    experiment.guardrailMetricIds.filter((id) => !decisionGuardrails.has(id)),
  );
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const hoursError =
    !Number.isFinite(conversionHours) || conversionHours < 0
      ? "Conversion Window must be zero or greater."
      : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (hoursError) return;
    setState("saving");
    try {
      const result = await updateControlPanelExperiment({
        data: {
          appId,
          environmentId,
          experimentId: experiment.id,
          patch: {
            conversionWindowMs: Math.round(conversionHours * 3_600_000),
            metrics: metricRefs([...decisionMetrics, ...secondary]),
            guardrailMetrics: metricRefs([...decisionGuardrails, ...guardrails]),
          },
        },
      });
      if (!result.ok) {
        setState("error");
        return;
      }
      setState("saved");
      await refresh();
    } catch {
      setState("error");
    }
  }

  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader>
          <CardTitle>Current measurement configuration</CardTitle>
          <CardDescription>
            Safe edits recompute over the existing Run. They do not reset its sample.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={Boolean(hoursError)}>
              <FieldLabel htmlFor="experiment-conversion-window">Conversion Window</FieldLabel>
              <Input
                aria-invalid={Boolean(hoursError)}
                id="experiment-conversion-window"
                min={0}
                onChange={(event) => {
                  setConversionHours(event.target.valueAsNumber);
                  setState("idle");
                }}
                step={1}
                type="number"
                value={Number.isFinite(conversionHours) ? conversionHours : ""}
              />
              <FieldDescription>
                Hours after first Exposure included in measurement.
              </FieldDescription>
              <FieldError>{hoursError}</FieldError>
            </Field>
            <MetricChoices
              label="Secondary Metrics"
              metrics={metrics}
              onChange={(ids) => {
                setSecondary(ids);
                setState("idle");
              }}
              selected={secondary}
            />
            <MetricChoices
              label="Exploratory guardrails"
              metrics={metrics}
              onChange={(ids) => {
                setGuardrails(ids);
                setState("idle");
              }}
              selected={guardrails}
            />
            {state === "error" ? (
              <Alert variant="destructive">
                <AlertTitle>Measurement not saved</AlertTitle>
                <AlertDescription>
                  The Worker refused the edit. Check the fields and retry.
                </AlertDescription>
              </Alert>
            ) : null}
            {state === "saved" ? (
              <Alert>
                <AlertTitle>Measurement saved</AlertTitle>
                <AlertDescription>
                  Existing Run history is unchanged. Analysis will recompute from the raw log.
                </AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end">
          <Button disabled={state === "saving" || Boolean(hoursError)} type="submit">
            {state === "saving" ? <Spinner data-icon="inline-start" /> : null}
            {state === "saving" ? "Saving…" : "Save measurement"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

function MetricChoices({
  label,
  metrics,
  onChange,
  selected,
}: {
  label: string;
  metrics: MetricOption[];
  onChange: (ids: string[]) => void;
  selected: string[];
}) {
  const selectedSet = new Set(selected);
  return (
    <FieldSet>
      <FieldLegend variant="label">{label}</FieldLegend>
      <FieldDescription>Selections remain exploratory for the current Run.</FieldDescription>
      <FieldGroup data-slot="checkbox-group">
        {metrics.length === 0 ? (
          <p className="text-muted-foreground text-sm">No Metrics exist in this App.</p>
        ) : (
          metrics.map((metric) => (
            <Field key={metric.id} orientation="horizontal">
              <Checkbox
                checked={selectedSet.has(metric.id)}
                id={`${slug(label)}-${metric.id}`}
                onCheckedChange={(checked) =>
                  onChange(
                    checked ? [...selected, metric.id] : selected.filter((id) => id !== metric.id),
                  )
                }
              />
              <FieldLabel htmlFor={`${slug(label)}-${metric.id}`}>
                {metric.name}
                <span className="font-mono text-muted-foreground text-xs">{metric.id}</span>
              </FieldLabel>
            </Field>
          ))
        )}
      </FieldGroup>
    </FieldSet>
  );
}

function metricRefs(ids: string[]) {
  return [...new Set(ids)].map((metricId) => ({ metricId }));
}

function slug(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}
