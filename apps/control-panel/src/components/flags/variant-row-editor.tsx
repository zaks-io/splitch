import { Button } from "@splitch/ui/components/button";
import { Input } from "@splitch/ui/components/input";
import type { DraftIssue, VariantDraft, VariantValueType } from "#lib/flags/create-flag-model";
import { issueFor } from "#lib/flags/create-flag-model";

export function VariantRowEditor({
  index,
  variant,
  valueType,
  isDefault,
  canRemove,
  isFirst,
  isLast,
  issues,
  onChange,
  onMakeDefault,
  onMove,
  onRemove,
}: {
  index: number;
  variant: VariantDraft;
  valueType: VariantValueType;
  isDefault: boolean;
  canRemove: boolean;
  isFirst: boolean;
  isLast: boolean;
  issues: DraftIssue[];
  onChange: (patch: Partial<VariantDraft>) => void;
  onMakeDefault: () => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const nameError = issueFor(issues, `variants.${index}.name`);
  const valueError = issueFor(issues, `variants.${index}.value`);
  /** An unnamed row still needs a distinct accessible name for its controls. */
  const variantLabel = variant.name || `Variant ${index + 1}`;

  return (
    <div
      className="grid gap-2 px-3 py-3"
      data-variant-name={variant.name}
      data-testid={`variant-row-${index}`}
    >
      <div className="flex items-start gap-2">
        <div className="grid flex-1 gap-1">
          <label className="text-muted-foreground text-xs" htmlFor={`variant-name-${index}`}>
            Name
          </label>
          <Input
            aria-describedby={nameError ? `variant-name-error-${index}` : undefined}
            aria-invalid={Boolean(nameError)}
            autoComplete="off"
            id={`variant-name-${index}`}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="control"
            value={variant.name}
          />
        </div>
        <div className="grid flex-1 gap-1">
          <label className="text-muted-foreground text-xs" htmlFor={`variant-value-${index}`}>
            Value
          </label>
          <Input
            aria-describedby={valueError ? `variant-value-error-${index}` : undefined}
            aria-invalid={Boolean(valueError)}
            autoComplete="off"
            id={`variant-value-${index}`}
            onChange={(event) => onChange({ value: event.target.value })}
            placeholder={valuePlaceholder(valueType)}
            value={variant.value}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm" htmlFor={`variant-default-${index}`}>
          <input
            // Every radio in the group reads as "Default" otherwise, so a
            // screen reader cannot tell which Variant it selects.
            aria-label={`Make ${variantLabel} the Default`}
            checked={isDefault}
            id={`variant-default-${index}`}
            name="default-variant"
            onChange={onMakeDefault}
            type="radio"
          />
          Default
        </label>
        <Button
          aria-label={`Move ${variantLabel} up`}
          disabled={isFirst}
          onClick={() => onMove(index - 1)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Up
        </Button>
        <Button
          aria-label={`Move ${variantLabel} down`}
          disabled={isLast}
          onClick={() => onMove(index + 1)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Down
        </Button>
        <Button
          aria-label={`Remove ${variantLabel}`}
          disabled={!canRemove}
          onClick={onRemove}
          size="sm"
          type="button"
          variant="ghost"
        >
          Remove
        </Button>
      </div>

      {nameError ? (
        <p className="text-destructive text-xs" id={`variant-name-error-${index}`}>
          {nameError}
        </p>
      ) : null}
      {valueError ? (
        <p className="text-destructive text-xs" id={`variant-value-error-${index}`}>
          {valueError}
        </p>
      ) : null}
    </div>
  );
}

function valuePlaceholder(valueType: VariantValueType): string {
  if (valueType === "boolean") return "true";
  if (valueType === "number") return "42";
  if (valueType === "object") return '{ "limit": 10 }';
  return "control";
}
