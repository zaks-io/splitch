import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { Input } from "@splitch/ui/components/input";
import { type FormEvent, useState } from "react";
import { type MutationErrorSurface, mutationErrorSurface } from "#lib/api";
import { createControlPanelFlag } from "#lib/control-plane-flag-functions";
import { booleanFlagInput, flagFieldError } from "#lib/create-flag-model";

export function CreateFlagForm({
  appId,
  environmentId,
  onCreated,
}: {
  appId: string;
  environmentId: string;
  onCreated: (key: string) => void;
}) {
  const [key, setKey] = useState("");
  const [requiredError, setRequiredError] = useState<string>();
  const [mutationError, setMutationError] = useState<MutationErrorSurface | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const keyError = requiredError ?? flagFieldError(mutationError, "key");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = booleanFlagInput(appId, key);
    if (!input.key) {
      setRequiredError("Enter a Flag key.");
      return;
    }

    setRequiredError(undefined);
    setMutationError(null);
    setIsSubmitting(true);
    try {
      const result = await createControlPanelFlag({
        data: { appId: input.appId, environmentId, key: input.key },
      });
      if (result.ok) onCreated(result.data.key);
      else setMutationError(mutationErrorSurface(result));
    } catch {
      setMutationError({
        kind: "form",
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
          Start with a boolean toggle. You can expand its Variant catalog later.
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
          onChange={(event) => {
            setKey(event.target.value);
            setRequiredError(undefined);
            setMutationError(null);
          }}
          placeholder="new-checkout"
          value={key}
        />
        <p
          className={keyError ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
          id={keyError ? "flag-key-error" : "flag-key-help"}
        >
          {keyError ?? "Unique within this App."}
        </p>
      </div>

      <section className="grid gap-2" aria-labelledby="variant-catalog-title">
        <div>
          <h3 className="font-medium text-sm" id="variant-catalog-title">
            Variant catalog
          </h3>
          <p className="text-muted-foreground text-xs">Boolean values are ready with no JSON.</p>
        </div>
        <div className="divide-y rounded-lg border border-border" data-testid="boolean-catalog">
          {[
            { name: "disabled", value: "false", isDefault: true },
            { name: "enabled", value: "true", isDefault: false },
          ].map((variant) => (
            <div className="flex items-center justify-between gap-3 px-3 py-2.5" key={variant.name}>
              <div className="grid gap-0.5">
                <span className="font-medium text-sm">{variant.name}</span>
                <code className="text-muted-foreground text-xs">{variant.value}</code>
              </div>
              {variant.isDefault ? <Badge variant="secondary">Default</Badge> : null}
            </div>
          ))}
        </div>
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
