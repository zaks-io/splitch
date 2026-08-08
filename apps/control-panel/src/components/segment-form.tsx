import type { PanelSegment } from "@splitch/control-plane-sdk/panel-segments";
import { DialogDescription, DialogHeader, DialogTitle } from "@splitch/ui/components/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import { Textarea } from "@splitch/ui/components/textarea";
import { segmentIssueFor } from "#lib/segment-form-model";
import { ConditionEditor } from "./condition-editor";
import { SegmentFormFooter } from "./segment-form-footer";
import { SegmentMutationError } from "./segment-mutation-error";
import { useSegmentForm, workerSegmentFieldError } from "./use-segment-form";

type SegmentFormProps = {
  appId: string;
  environmentId: string;
  onDeleted: (segmentId: string) => void | Promise<void>;
  onSaved: (segment: PanelSegment) => void | Promise<void>;
  segment?: PanelSegment;
};

export function SegmentForm({
  appId,
  environmentId,
  onDeleted,
  onSaved,
  segment,
}: SegmentFormProps) {
  const form = useSegmentForm({
    appId,
    environmentId,
    onDeleted,
    onSaved,
    segment,
  });
  const {
    addCondition,
    busyAction,
    draft,
    edit,
    editCondition,
    mutationError,
    remove,
    removeCondition,
    shown,
    submit,
  } = form;
  const nameError =
    segmentIssueFor(shown, "name") ?? workerSegmentFieldError(mutationError, "name");

  return (
    <form className="flex flex-col gap-5" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{segment ? `Edit ${segment.name}` : "Create Segment"}</DialogTitle>
        <DialogDescription>
          Edits apply across every Environment in this App. Define the reusable Condition set once.
        </DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <Field data-invalid={Boolean(nameError)}>
          <FieldLabel htmlFor="segment-name">Segment name</FieldLabel>
          <Input
            aria-invalid={Boolean(nameError)}
            autoComplete="off"
            id="segment-name"
            onChange={(event) => edit({ name: event.target.value })}
            placeholder="Paid plan"
            value={draft.name}
          />
          {nameError ? <FieldError>{nameError}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="segment-description">Description</FieldLabel>
          <Textarea
            id="segment-description"
            onChange={(event) => edit({ description: event.target.value })}
            placeholder="Entities on a paid plan."
            value={draft.description}
          />
        </Field>
        <ConditionEditor
          conditions={draft.conditions}
          mutationError={mutationError}
          onAdd={addCondition}
          onEdit={editCondition}
          onRemove={removeCondition}
          shown={shown}
        />
      </FieldGroup>

      <SegmentMutationError error={mutationError} />
      <SegmentFormFooter busyAction={busyAction} remove={remove} segment={segment} />
    </form>
  );
}
