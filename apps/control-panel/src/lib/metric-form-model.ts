import {
  type CreateMetricRequest,
  type Metric,
  type MetricKind,
  MetricKindSchema,
  type PatchMetricRequest,
} from "@splitch/contracts";
import { z } from "zod";

const METRIC_KINDS: ReadonlyArray<{ kind: MetricKind; label: string }> = [
  { kind: "binomial", label: "Binomial" },
  { kind: "count", label: "Count" },
  { kind: "revenue", label: "Revenue" },
  { kind: "ratio", label: "Ratio" },
];

export function metricKindOptions(hasDenominatorCandidates: boolean): ReadonlyArray<{
  kind: MetricKind;
  label: string;
  disabled: boolean;
}> {
  return METRIC_KINDS.map(({ kind, label }) => {
    const disabled = kind === "ratio" && !hasDenominatorCandidates;
    return {
      kind,
      label: disabled ? `${label} (create another Metric first)` : label,
      disabled,
    };
  });
}

export const MetricDraftSchema = z
  .object({
    name: z.string(),
    key: z.string(),
    description: z.string(),
    kind: MetricKindSchema,
    eventDefinitionId: z.string(),
    eventFieldName: z.string(),
    denominatorMetricId: z.string(),
  })
  .strict();

export type MetricDraft = z.infer<typeof MetricDraftSchema>;

export type MetricDraftIssue = {
  path: keyof MetricDraft;
  message: string;
};

export function emptyMetricDraft(): MetricDraft {
  return {
    name: "",
    key: "",
    description: "",
    kind: "binomial",
    eventDefinitionId: "",
    eventFieldName: "",
    denominatorMetricId: "",
  };
}

export function metricDraft(metric: Metric): MetricDraft {
  return {
    name: metric.name,
    key: metric.key,
    description: metric.description ?? "",
    kind: metric.kind,
    eventDefinitionId: metric.eventDefinitionId,
    eventFieldName: metric.eventFieldName ?? "",
    denominatorMetricId: metric.denominator?.metricId ?? "",
  };
}

export function metricDraftIssues(draft: MetricDraft): MetricDraftIssue[] {
  const issues: MetricDraftIssue[] = [];
  required(issues, draft.name, "name", "Enter a Metric name.");
  required(issues, draft.key, "key", "Enter a Metric key.");
  required(
    issues,
    draft.eventDefinitionId,
    "eventDefinitionId",
    "Enter the event name this Metric measures.",
  );
  if (draft.kind === "count" || draft.kind === "revenue") {
    required(
      issues,
      draft.eventFieldName,
      "eventFieldName",
      `Enter the event value field for this ${draft.kind} Metric.`,
    );
  }
  if (draft.kind === "ratio") {
    required(
      issues,
      draft.denominatorMetricId,
      "denominatorMetricId",
      "Choose a denominator Metric.",
    );
  }
  return issues;
}

export function metricCreateInput(appId: string, draft: MetricDraft): CreateMetricRequest {
  return {
    appId,
    name: draft.name.trim(),
    key: draft.key.trim(),
    kind: draft.kind,
    eventDefinitionId: draft.eventDefinitionId.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(draft.kind === "count" || draft.kind === "revenue"
      ? { eventFieldName: draft.eventFieldName.trim() }
      : {}),
    ...(draft.kind === "ratio" ? { denominator: { metricId: draft.denominatorMetricId } } : {}),
  };
}

export function metricUpdateInput(draft: MetricDraft): PatchMetricRequest {
  return {
    name: draft.name.trim(),
    key: draft.key.trim(),
    description: draft.description.trim(),
    eventDefinitionId: draft.eventDefinitionId.trim(),
    ...(draft.kind === "count" || draft.kind === "revenue"
      ? { eventFieldName: draft.eventFieldName.trim() }
      : {}),
    ...(draft.kind === "ratio" ? { denominator: { metricId: draft.denominatorMetricId } } : {}),
  };
}

export function metricIssueFor(
  issues: readonly MetricDraftIssue[],
  path: keyof MetricDraft,
): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

function required(
  issues: MetricDraftIssue[],
  value: string,
  path: MetricDraftIssue["path"],
  message: string,
): void {
  if (!value.trim()) issues.push({ path, message });
}
