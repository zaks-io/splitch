import type { PanelSegment } from "@splitch/control-plane-sdk/panel-segments";
import type { FormEvent } from "react";
import { useState } from "react";
import { type MutationErrorSurface, mutationErrorSurface } from "#lib/shared/api";
import {
  deleteControlPanelSegment,
  saveControlPanelSegment,
} from "#lib/segments/control-plane-segment-functions";
import {
  emptyConditionDraft,
  emptySegmentDraft,
  type SegmentDraft,
  segmentDraft,
  segmentDraftIssues,
} from "#lib/segments/segment-form-model";

export function useSegmentForm({
  appId,
  environmentId,
  segment,
  onDeleted,
  onSaved,
}: {
  appId: string;
  environmentId: string;
  segment?: PanelSegment;
  onDeleted: (segmentId: string) => void | Promise<void>;
  onSaved: (segment: PanelSegment) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<SegmentDraft>(() =>
    segment ? segmentDraft(segment) : emptySegmentDraft(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [mutationError, setMutationError] = useState<MutationErrorSurface | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "delete" | null>(null);
  const issues = segmentDraftIssues(draft);

  function edit(patch: Partial<SegmentDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setMutationError(null);
  }

  function editCondition(index: number, patch: Partial<SegmentDraft["conditions"][number]>) {
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.map((condition, conditionIndex) =>
        conditionIndex === index ? { ...condition, ...patch } : condition,
      ),
    }));
    setMutationError(null);
  }

  function addCondition() {
    setDraft((current) => ({
      ...current,
      conditions: [...current.conditions, emptyConditionDraft()],
    }));
    setMutationError(null);
  }

  function removeCondition(index: number) {
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.filter((_, conditionIndex) => conditionIndex !== index),
    }));
    setMutationError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (issues.length > 0) return;
    setBusyAction("save");
    setMutationError(null);
    try {
      const result = await saveControlPanelSegment({
        data: {
          appId,
          environmentId,
          ...(segment ? { segmentId: segment.id } : {}),
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
    if (!segment || !window.confirm(`Delete ${segment.name}? This cannot be undone.`)) return;
    setBusyAction("delete");
    setMutationError(null);
    try {
      const result = await deleteControlPanelSegment({
        data: { appId, environmentId, segmentId: segment.id },
      });
      if (result.ok) await onDeleted(segment.id);
      else setMutationError(mutationErrorSurface(result));
    } catch {
      setMutationError(transportError("delete"));
    } finally {
      setBusyAction(null);
    }
  }

  return {
    addCondition,
    busyAction,
    draft,
    edit,
    editCondition,
    mutationError,
    remove,
    removeCondition,
    shown: submitted ? issues : [],
    submit,
  };
}

export function workerSegmentFieldError(
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
    code: "TRANSPORT_FAILURE",
    message: `The Control Plane could not ${operation} this Segment. Try again.`,
    fields: [],
  };
}
