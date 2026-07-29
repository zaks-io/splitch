import type { Metric } from "@splitch/contracts";
import type { FormEvent } from "react";
import { useState } from "react";
import { type MutationErrorSurface, mutationErrorSurface } from "#lib/api";
import {
  deleteControlPanelMetric,
  saveControlPanelMetric,
} from "#lib/control-plane-metric-functions";
import {
  emptyMetricDraft,
  metricDraft,
  type MetricDraft,
  metricDraftIssues,
} from "#lib/metric-form-model";

export function useMetricForm({
  appId,
  environmentId,
  metric,
  metrics,
  onDeleted,
  onSaved,
}: {
  appId: string;
  environmentId: string;
  metric?: Metric;
  metrics: Metric[];
  onDeleted: (metricId: string) => void | Promise<void>;
  onSaved: (metric: Metric) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<MetricDraft>(() =>
    metric ? metricDraft(metric) : emptyMetricDraft(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [mutationError, setMutationError] = useState<MutationErrorSurface | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "delete" | null>(null);
  const issues = metricDraftIssues(draft);

  function edit(patch: Partial<MetricDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setMutationError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (issues.length > 0) return;
    setBusyAction("save");
    setMutationError(null);
    try {
      const result = await saveControlPanelMetric({
        data: {
          appId,
          environmentId,
          ...(metric ? { metricId: metric.id } : {}),
          draft,
        },
      });
      if (result.ok) await onSaved(result.data);
      else setMutationError(mutationErrorSurface(result));
    } catch {
      setMutationError(transportError("save"));
    } finally {
      setBusyAction(null);
    }
  }

  async function remove() {
    if (!metric || !window.confirm(`Delete ${metric.name}? This cannot be undone.`)) return;
    setBusyAction("delete");
    setMutationError(null);
    try {
      const result = await deleteControlPanelMetric({
        data: { appId, environmentId, metricId: metric.id },
      });
      if (result.ok) await onDeleted(metric.id);
      else setMutationError(mutationErrorSurface(result));
    } catch {
      setMutationError(transportError("delete"));
    } finally {
      setBusyAction(null);
    }
  }

  return {
    busyAction,
    denominatorMetrics: metrics.filter(({ id }) => id !== metric?.id),
    draft,
    edit,
    mutationError,
    remove,
    shown: submitted ? issues : [],
    submit,
  };
}

export function workerMetricFieldError(
  error: MutationErrorSurface | null,
  field: string,
): string | undefined {
  if (error?.kind !== "field") return undefined;
  return error.fields.find(({ field: path }) => path === field || path === `body.${field}`)
    ?.message;
}

function transportError(operation: "save" | "delete"): MutationErrorSurface {
  return {
    kind: "form",
    message: `The Control Plane could not ${operation} this Metric. Try again.`,
    fields: [],
  };
}
