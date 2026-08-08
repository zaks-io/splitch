import type { ConditionOperator } from "@splitch/contracts";
import { Button } from "@splitch/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import type { MutationErrorSurface } from "#lib/api";
import {
  type ConditionDraft,
  conditionOperatorOptions,
  isListOperator,
  type SegmentDraftIssue,
  segmentIssueFor,
} from "#lib/segment-form-model";
import { workerSegmentFieldError } from "./use-segment-form";

export function ConditionEditor({
  conditions,
  mutationError,
  onAdd,
  onEdit,
  onRemove,
  shown,
}: {
  conditions: ConditionDraft[];
  mutationError: MutationErrorSurface | null;
  onAdd: () => void;
  onEdit: (index: number, patch: Partial<ConditionDraft>) => void;
  onRemove: (index: number) => void;
  shown: readonly SegmentDraftIssue[];
}) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <p className="font-medium text-sm">Conditions</p>
        <p className="text-muted-foreground text-sm">
          Every Condition must match (AND). Entities in this Segment satisfy the full set.
        </p>
        {segmentIssueFor(shown, "conditions") ? (
          <FieldError>{segmentIssueFor(shown, "conditions")}</FieldError>
        ) : null}
      </div>

      {conditions.map((condition, index) => (
        <ConditionRow
          condition={condition}
          index={index}
          key={condition.key}
          mutationError={mutationError}
          onEdit={onEdit}
          onRemove={onRemove}
          removable={conditions.length > 1}
          shown={shown}
        />
      ))}

      <div>
        <Button onClick={onAdd} type="button" variant="outline">
          Add Condition
        </Button>
      </div>
    </div>
  );
}

function ConditionRow({
  condition,
  index,
  mutationError,
  onEdit,
  onRemove,
  removable,
  shown,
}: {
  condition: ConditionDraft;
  index: number;
  mutationError: MutationErrorSurface | null;
  onEdit: (index: number, patch: Partial<ConditionDraft>) => void;
  onRemove: (index: number) => void;
  removable: boolean;
  shown: readonly SegmentDraftIssue[];
}) {
  const attributeError =
    segmentIssueFor(shown, `conditions.${index}.attribute`) ??
    workerSegmentFieldError(mutationError, `conditions.${index}.attribute`);
  const valueError =
    segmentIssueFor(shown, `conditions.${index}.valueText`) ??
    workerSegmentFieldError(mutationError, `conditions.${index}.value`) ??
    workerSegmentFieldError(mutationError, `conditions.${index}`);
  const list = isListOperator(condition.operator);

  return (
    <div className="grid gap-3 border border-border p-3" data-condition-index={index}>
      <Field data-invalid={Boolean(attributeError)}>
        <FieldLabel htmlFor={`segment-condition-${index}-attribute`}>Attribute</FieldLabel>
        <Input
          aria-invalid={Boolean(attributeError)}
          autoComplete="off"
          id={`segment-condition-${index}-attribute`}
          onChange={(event) => onEdit(index, { attribute: event.target.value })}
          placeholder="plan"
          value={condition.attribute}
        />
        {attributeError ? <FieldError>{attributeError}</FieldError> : null}
      </Field>

      <Field>
        <FieldLabel htmlFor={`segment-condition-${index}-operator`}>Operator</FieldLabel>
        <Select
          onValueChange={(value) =>
            onEdit(index, { operator: value as ConditionOperator, valueText: "" })
          }
          value={condition.operator}
        >
          <SelectTrigger className="w-full" id={`segment-condition-${index}-operator`}>
            <SelectValue placeholder="Choose an operator" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {conditionOperatorOptions().map(({ label, operator }) => (
                <SelectItem key={operator} value={operator}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <Field data-invalid={Boolean(valueError)}>
        <FieldLabel htmlFor={`segment-condition-${index}-value`}>
          {list ? "Values" : "Value"}
        </FieldLabel>
        <Input
          aria-invalid={Boolean(valueError)}
          autoComplete="off"
          id={`segment-condition-${index}-value`}
          onChange={(event) => onEdit(index, { valueText: event.target.value })}
          placeholder={list ? "US, CA" : "paid"}
          value={condition.valueText}
        />
        {valueError ? <FieldError>{valueError}</FieldError> : null}
        {!valueError && list ? (
          <FieldDescription>Comma-separated list for in / not in.</FieldDescription>
        ) : null}
      </Field>

      {removable ? (
        <div>
          <Button onClick={() => onRemove(index)} type="button" variant="ghost">
            Remove Condition
          </Button>
        </div>
      ) : null}
    </div>
  );
}
