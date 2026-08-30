import type { ConditionOperator } from "@splitch/contracts";
import { Button } from "@splitch/ui/components/button";
import { Field, FieldLabel } from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import {
  type ConditionValueEntry,
  type ConditionValueType,
  isPolymorphicValueOperator,
} from "#lib/segments/segment-form-model";

const VALUE_TYPE_OPTIONS: ReadonlyArray<{ type: ConditionValueType; label: string }> = [
  { type: "string", label: "String" },
  { type: "number", label: "Number" },
  { type: "boolean", label: "True or false" },
];

export function ConditionValueRow({
  entry,
  index,
  list,
  onEdit,
  onRemove,
  operator,
  removable,
  valueIndex,
}: {
  entry: ConditionValueEntry;
  index: number;
  list: boolean;
  onEdit: (patch: Partial<ConditionValueEntry>) => void;
  onRemove?: () => void;
  operator: ConditionOperator;
  removable: boolean;
  valueIndex: number;
}) {
  const inputId = `segment-condition-${index}-value-${valueIndex}`;
  const typeId = `segment-condition-${index}-type-${valueIndex}`;
  const showType = isPolymorphicValueOperator(operator);

  return (
    <div className="flex flex-wrap items-end gap-2">
      {showType ? (
        <Field className="w-40">
          <FieldLabel htmlFor={typeId}>Type</FieldLabel>
          <Select
            onValueChange={(value) => {
              if (value !== null) onEdit({ type: value as ConditionValueType });
            }}
            value={entry.type}
          >
            <SelectTrigger className="w-full" id={typeId}>
              <SelectValue placeholder="Choose a type" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {VALUE_TYPE_OPTIONS.map(({ label, type }) => (
                  <SelectItem key={type} value={type}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
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

export function applyConditionValuePatch(
  entry: ConditionValueEntry,
  patch: Partial<ConditionValueEntry>,
): ConditionValueEntry {
  const next = { ...entry, ...patch };
  if (patch.type === "boolean" && entry.type !== "boolean") {
    next.text = entry.text === "false" ? "false" : "true";
  }
  return next;
}
