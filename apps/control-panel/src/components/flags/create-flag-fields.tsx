import { Input } from "@splitch/ui/components/input";
import { Textarea } from "@splitch/ui/components/textarea";
import { VARIANT_VALUE_TYPES, type VariantValueType } from "#lib/flags/create-flag-model";

/**
 * The Flag definition fields of the Create Flag form. Purely presentational:
 * draft state, validation, and the name-suggests-key rule stay in
 * `CreateFlagForm`.
 */

type FieldProps = {
  error: string | undefined;
  onChange: (value: string) => void;
  value: string;
};

export function FlagNameField({ error, onChange, value }: FieldProps) {
  return (
    <div className="grid gap-2">
      <label className="font-medium text-sm" htmlFor="flag-name">
        Flag name
      </label>
      <Input
        aria-describedby={error ? "flag-name-error" : undefined}
        aria-invalid={Boolean(error)}
        autoComplete="off"
        id="flag-name"
        name="name"
        onChange={(event) => onChange(event.target.value)}
        placeholder="New Checkout"
        value={value}
      />
      {error ? (
        <p className="text-destructive text-xs" id="flag-name-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function FlagKeyField({ error, onChange, value }: FieldProps) {
  return (
    <div className="grid gap-2">
      <label className="font-medium text-sm" htmlFor="flag-key">
        Flag key
      </label>
      <Input
        aria-describedby={error ? "flag-key-error" : "flag-key-help"}
        aria-invalid={Boolean(error)}
        autoComplete="off"
        id="flag-key"
        name="key"
        onChange={(event) => onChange(event.target.value)}
        placeholder="new-checkout"
        value={value}
      />
      <p
        className={error ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
        id={error ? "flag-key-error" : "flag-key-help"}
      >
        {error ?? "How code and selectors reference this Flag. Unique within this App."}
      </p>
    </div>
  );
}

export function FlagValueTypeField({
  onChange,
  value,
}: {
  onChange: (valueType: VariantValueType) => void;
  value: VariantValueType;
}) {
  return (
    <div className="grid gap-2">
      <label className="font-medium text-sm" htmlFor="flag-value-type">
        Variant value type
      </label>
      <select
        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
        id="flag-value-type"
        onChange={(event) => onChange(event.target.value as VariantValueType)}
        value={value}
      >
        {VARIANT_VALUE_TYPES.map((valueType) => (
          <option key={valueType} value={valueType}>
            {valueType}
          </option>
        ))}
      </select>
      <p className="text-muted-foreground text-xs">
        Every Variant in this Flag carries a {value} value.
      </p>
    </div>
  );
}

export function FlagSchemaField({ error, onChange, value }: FieldProps) {
  return (
    <div className="grid gap-2">
      <label className="font-medium text-sm" htmlFor="flag-schema">
        JSON Schema
      </label>
      <Textarea
        aria-describedby={error ? "flag-schema-error" : "flag-schema-help"}
        aria-invalid={Boolean(error)}
        className="min-h-24 font-mono text-xs"
        id="flag-schema"
        name="schema"
        onChange={(event) => onChange(event.target.value)}
        placeholder={'{ "properties": { "color": { "type": "string" } }, "required": ["color"] }'}
        spellCheck={false}
        value={value}
      />
      <p
        className={error ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
        id={error ? "flag-schema-error" : "flag-schema-help"}
      >
        {error ?? "Optional. Every Variant value must pass it."}
      </p>
    </div>
  );
}
