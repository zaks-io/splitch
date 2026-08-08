import type { ConditionOperator } from "@splitch/contracts";
import { Button } from "@splitch/ui/components/button";
import { Field, FieldError, FieldLabel } from "@splitch/ui/components/field";
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
  type ConditionValueEntry,
  conditionOperatorOptions,
  conditionWithOperator,
  emptyValueEntry,
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
          removable
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
    workerSegmentFieldError(mutationError, `conditions.${index}.value`) ??
    workerSegmentFieldError(mutationError, `conditions.${index}`);
  const list = isListOperator(condition.operator);

  return (
    <div className="grid gap-3 rounded-md border border-border p-3" data-condition-index={index}>
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
            onEdit(index, conditionWithOperator(condition, value as ConditionOperator))
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

      <ConditionValues
        condition={condition}
        index={index}
        list={list}
        onEdit={onEdit}
        valueError={valueError}
      />

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

function ConditionValues({
  condition,
  index,
  list,
  onEdit,
  valueError,
}: {
  condition: ConditionDraft;
  index: number;
  list: boolean;
  onEdit: (index: number, patch: Partial<ConditionDraft>) => void;
  valueError: string | undefined;
}) {
  function editValue(valueIndex: number, patch: Partial<ConditionValueEntry>) {
    const current =
      condition.values.length > 0 ? condition.values : list ? [] : [emptyValueEntry()];
    const ensured = current[valueIndex] !== undefined ? current : [...current, emptyValueEntry()];
    onEdit(index, {
      values: ensured.map((entry, entryIndex) =>
        entryIndex === valueIndex ? { ...entry, ...patch } : entry,
      ),
    });
  }

  function addValue() {
    onEdit(index, { values: [...condition.values, emptyValueEntry()] });
  }

  function removeValue(valueIndex: number) {
    onEdit(index, {
      values: condition.values.filter((_, entryIndex) => entryIndex !== valueIndex),
    });
  }

  const values = list
    ? condition.values
    : condition.values.slice(0, 1).length > 0
      ? condition.values.slice(0, 1)
      : [emptyValueEntry()];

  return (
    <div className="grid gap-2">
      <p className="font-medium text-sm">{list ? "Values" : "Value"}</p>
      {valueError ? <FieldError>{valueError}</FieldError> : null}
      {values.map((entry, valueIndex) => (
        <ValueRow
          entry={entry}
          index={index}
          key={entry.key}
          list={list}
          onEdit={(patch) => editValue(valueIndex, patch)}
          onRemove={list ? () => removeValue(valueIndex) : undefined}
          removable={list && values.length > 1}
          valueIndex={valueIndex}
        />
      ))}
      {list ? (
        <div>
          <Button onClick={addValue} type="button" variant="outline">
            Add value
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ValueRow({
  entry,
  index,
  list,
  onEdit,
  onRemove,
  removable,
  valueIndex,
}: {
  entry: ConditionValueEntry;
  index: number;
  list: boolean;
  onEdit: (patch: Partial<ConditionValueEntry>) => void;
  onRemove?: () => void;
  removable: boolean;
  valueIndex: number;
}) {
  const inputId = `segment-condition-${index}-value-${valueIndex}`;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field className="min-w-40 flex-1">
        <FieldLabel htmlFor={inputId}>{list ? `Value ${valueIndex + 1}` : "Value"}</FieldLabel>
        {entry.type === "boolean" ? (
          <Select
            onValueChange={(value) => {
              if (value !== null) onEdit({ text: value });
            }}
            value={entry.text === "false" ? "false" : "true"}
          >
            <SelectTrigger className="w-full" id={inputId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">true</SelectItem>
              <SelectItem value="false">false</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Input
            autoComplete="off"
            id={inputId}
            onChange={(event) => onEdit({ text: event.target.value })}
            placeholder={list ? "US" : "paid"}
            value={entry.text}
          />
        )}
      </Field>
      {removable && onRemove ? (
        <Button onClick={onRemove} type="button" variant="ghost">
          Remove value
        </Button>
      ) : null}
    </div>
  );
}
