import type { Metric } from "@splitch/contracts";
import { DialogDescription, DialogHeader, DialogTitle } from "@splitch/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@splitch/ui/components/field";
import { Textarea } from "@splitch/ui/components/textarea";
import { MetricFactFields } from "./metric-fact-fields";
import { MetricFormFooter } from "./metric-form-footer";
import { MetricMutationError } from "./metric-mutation-error";
import { MetricTextField } from "./metric-text-field";
import { useMetricForm, workerMetricFieldError } from "./use-metric-form";

type MetricFormProps = {
  appId: string;
  environmentId: string;
  metric?: Metric;
  metrics: Metric[];
  onDeleted: (metricId: string) => void | Promise<void>;
  onSaved: (metric: Metric) => void | Promise<void>;
};

export function MetricForm({
  appId,
  environmentId,
  metric,
  metrics,
  onDeleted,
  onSaved,
}: MetricFormProps) {
  const form = useMetricForm({
    appId,
    environmentId,
    metric,
    metrics,
    onDeleted,
    onSaved,
  });
  const { busyAction, denominatorMetrics, draft, edit, mutationError, remove, shown, submit } =
    form;

  return (
    <form className="flex flex-col gap-5" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{editorTitle(metric)}</DialogTitle>
        <DialogDescription>
          Define the fact and aggregation here. Choose this Metric&apos;s role per Experiment.
        </DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <MetricTextField
          draft={draft}
          label="Metric name"
          onEdit={edit}
          path="name"
          placeholder="Checkout conversion"
          shown={shown}
          workerError={workerMetricFieldError(mutationError, "name")}
        />
        <MetricTextField
          description="Unique within this App."
          draft={draft}
          label="Metric key"
          onEdit={edit}
          path="key"
          placeholder="checkout-conversion"
          shown={shown}
          workerError={workerMetricFieldError(mutationError, "key")}
        />
        <Field>
          <FieldLabel htmlFor="metric-description">Description</FieldLabel>
          <Textarea
            id="metric-description"
            onChange={(event) => edit({ description: event.target.value })}
            placeholder="A completed checkout per exposed Entity."
            value={draft.description}
          />
        </Field>
        <MetricFactFields
          denominatorMetrics={denominatorMetrics}
          draft={draft}
          edit={edit}
          editing={Boolean(metric)}
          mutationError={mutationError}
          shown={shown}
        />
      </FieldGroup>

      <MetricMutationError error={mutationError} />
      <MetricFormFooter busyAction={busyAction} metric={metric} remove={remove} />
    </form>
  );
}

function editorTitle(metric?: Metric): string {
  return metric ? `Edit ${metric.name}` : "Create Metric";
}
