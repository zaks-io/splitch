import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { type FormEvent, useRef, useState } from "react";
import { type MutationErrorSurface, mutationErrorSurface } from "#lib/shared/api";
import {
  type CreatedFlagHandoff,
  createControlPanelFlag,
} from "#lib/flags/control-plane-flag-functions";
import {
  booleanPresetDraft,
  draftIssues,
  emptyVariantDraft,
  type FlagDraft,
  flagFieldError,
  issueFor,
  moveVariant,
  removeVariant,
  suggestFlagKey,
  switchValueType,
  typeSwitchClearsSchema,
  typeSwitchClearsValues,
  type VariantValueType,
} from "#lib/flags/create-flag-model";
import {
  FlagKeyField,
  FlagNameField,
  FlagSchemaField,
  FlagValueTypeField,
} from "#components/flags/create-flag-fields";
import { VariantRowEditor } from "#components/flags/variant-row-editor";

export function CreateFlagForm({
  appId,
  environmentId,
  onCreated,
}: {
  appId: string;
  environmentId: string;
  onCreated: (flag: CreatedFlagHandoff) => void;
}) {
  const [draft, setDraft] = useState(booleanPresetDraft);
  const [keyEdited, setKeyEdited] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [mutationError, setMutationError] = useState<MutationErrorSurface | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Minted here, at the submission boundary, so a double-click or a retry after a
  // failed response replays the SAME create instead of minting a second Flag.
  // Editing the draft or a successful create ends the attempt series.
  const idempotencyKey = useRef<string | null>(null);

  const issues = draftIssues(draft);
  const shown = submitted ? issues : [];
  const nameError = issueFor(shown, "name") ?? flagFieldError(mutationError, "name");
  const keyError = issueFor(shown, "key") ?? flagFieldError(mutationError, "key");
  const schemaError = issueFor(shown, "schema") ?? flagFieldError(mutationError, "schema");
  const defaultError = issueFor(shown, "defaultIndex");

  function edit(next: typeof draft) {
    setDraft(next);
    setMutationError(null);
    idempotencyKey.current = null;
  }

  function changeValueType(valueType: VariantValueType) {
    if (confirmedValueTypeSwitch(draft, valueType)) edit(switchValueType(draft, valueType));
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
        onCreated(result.data);
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

      <FlagNameField
        error={nameError}
        onChange={(name) =>
          edit({ ...draft, name, key: keyEdited ? draft.key : suggestFlagKey(name) })
        }
        value={draft.name}
      />

      <FlagKeyField
        error={keyError}
        onChange={(key) => {
          setKeyEdited(true);
          edit({ ...draft, key });
        }}
        value={draft.key}
      />

      <FlagValueTypeField onChange={changeValueType} value={draft.valueType} />

      {draft.valueType === "object" ? (
        <FlagSchemaField
          error={schemaError}
          onChange={(schemaText) => edit({ ...draft, schemaText })}
          value={draft.schemaText}
        />
      ) : null}

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

      {mutationError && !nameError && !keyError && !schemaError ? (
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

/** A type switch discards drafted work, so each discard is confirmed first. */
function confirmedValueTypeSwitch(draft: FlagDraft, valueType: VariantValueType): boolean {
  if (
    typeSwitchClearsValues(draft.variants, valueType) &&
    !window.confirm(`Switching to ${valueType} clears the Variant values you entered. Continue?`)
  ) {
    return false;
  }
  if (
    typeSwitchClearsSchema(draft, valueType) &&
    !window.confirm(`Switching to ${valueType} discards the JSON Schema you entered. Continue?`)
  ) {
    return false;
  }
  return true;
}
