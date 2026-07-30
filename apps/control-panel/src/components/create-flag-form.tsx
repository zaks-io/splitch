import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { Input } from "@splitch/ui/components/input";
import { type FormEvent, useRef, useState } from "react";
import { type MutationErrorSurface, mutationErrorSurface } from "#lib/api";
import { createControlPanelFlag } from "#lib/control-plane-flag-functions";
import {
  booleanPresetDraft,
  draftIssues,
  emptyVariantDraft,
  flagFieldError,
  issueFor,
  moveVariant,
  removeVariant,
  switchValueType,
  typeSwitchClearsValues,
  VARIANT_VALUE_TYPES,
  type VariantValueType,
} from "#lib/create-flag-model";
import { VariantRowEditor } from "./variant-row-editor";

export function CreateFlagForm({
  appId,
  environmentId,
  onCreated,
}: {
  appId: string;
  environmentId: string;
  onCreated: (key: string) => void;
}) {
  const [draft, setDraft] = useState(booleanPresetDraft);
  const [submitted, setSubmitted] = useState(false);
  const [mutationError, setMutationError] = useState<MutationErrorSurface | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Minted here, at the submission boundary, so a double-click or a retry after a
  // failed response replays the SAME create instead of minting a second Flag.
  // Editing the draft or a successful create ends the attempt series.
  const idempotencyKey = useRef<string | null>(null);

  const issues = draftIssues(draft);
  const shown = submitted ? issues : [];
  const keyError = issueFor(shown, "key") ?? flagFieldError(mutationError, "key");
  const defaultError = issueFor(shown, "defaultIndex");

  function edit(next: typeof draft) {
    setDraft(next);
    setMutationError(null);
    idempotencyKey.current = null;
  }

  function changeValueType(valueType: VariantValueType) {
    if (
      typeSwitchClearsValues(draft.variants, valueType) &&
      // Values that cannot survive the switch are discarded, so confirm first.
      !window.confirm(`Switching to ${valueType} clears the Variant values you entered. Continue?`)
    ) {
      return;
    }
    edit(switchValueType(draft, valueType));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (issues.length > 0) return;

    setMutationError(null);
    setIsSubmitting(true);
    try {
      idempotencyKey.current ??= crypto.randomUUID();
      const result = await createControlPanelFlag({
        data: { appId, environmentId, draft, idempotencyKey: idempotencyKey.current },
      });
      if (result.ok) {
        idempotencyKey.current = null;
        onCreated(result.data.key);
      } else setMutationError(mutationErrorSurface(result));
    } catch {
      setMutationError({
        kind: "form",
        code: "TRANSPORT_FAILURE",
        message: "The Control Plane could not create this Flag. Try again.",
        fields: [],
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Create Flag</DialogTitle>
        <DialogDescription>
          A Flag is a named set of Variants. Start with the on/off preset or define your own.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="flag-key">
          Flag key
        </label>
        <Input
          aria-describedby={keyError ? "flag-key-error" : "flag-key-help"}
          aria-invalid={Boolean(keyError)}
          autoComplete="off"
          id="flag-key"
          name="key"
          onChange={(event) => edit({ ...draft, key: event.target.value })}
          placeholder="new-checkout"
          value={draft.key}
        />
        <p
          className={keyError ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
          id={keyError ? "flag-key-error" : "flag-key-help"}
        >
          {keyError ?? "Unique within this App."}
        </p>
      </div>

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="flag-value-type">
          Variant value type
        </label>
        <select
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          id="flag-value-type"
          onChange={(event) => changeValueType(event.target.value as VariantValueType)}
          value={draft.valueType}
        >
          {VARIANT_VALUE_TYPES.map((valueType) => (
            <option key={valueType} value={valueType}>
              {valueType}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground text-xs">
          Every Variant in this Flag carries a {draft.valueType} value.
        </p>
      </div>

      <section aria-labelledby="variant-catalog-title" className="grid gap-2">
        <h3 className="font-medium text-sm" id="variant-catalog-title">
          Variant catalog
        </h3>
        <div className="divide-y rounded-lg border border-border" data-testid="variant-catalog">
          {draft.variants.map((variant, index) => (
            <VariantRowEditor
              canRemove={draft.variants.length > 1}
              index={index}
              isDefault={index === draft.defaultIndex}
              isFirst={index === 0}
              isLast={index === draft.variants.length - 1}
              issues={shown}
              // Rows are positional and names are still being typed, so the
              // index is the only stable identity available here.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
              key={index}
              onChange={(patch) =>
                edit({
                  ...draft,
                  variants: draft.variants.map((row, position) =>
                    position === index ? { ...row, ...patch } : row,
                  ),
                })
              }
              onMakeDefault={() => edit({ ...draft, defaultIndex: index })}
              onMove={(to) => edit(moveVariant(draft, index, to))}
              onRemove={() => edit(removeVariant(draft, index))}
              valueType={draft.valueType}
              variant={variant}
            />
          ))}
        </div>
        {defaultError ? <p className="text-destructive text-xs">{defaultError}</p> : null}
        <Button
          className="justify-self-start"
          onClick={() => edit({ ...draft, variants: [...draft.variants, emptyVariantDraft()] })}
          size="sm"
          type="button"
          variant="outline"
        >
          Add Variant
        </Button>
      </section>

      {mutationError && !keyError ? (
        <Alert variant="destructive">
          <AlertTitle>Flag not created</AlertTitle>
          <AlertDescription>{mutationError.message}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button disabled={isSubmitting} type="submit">
          {isSubmitting ? "Creating…" : "Create Flag"}
        </Button>
      </DialogFooter>
    </form>
  );
}
