import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
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
import { createControlPanelApp } from "#lib/control-plane-app-functions";
import {
  appIssueFor,
  type CreateAppDraft,
  draftAppIssues,
  emptyAppDraft,
  suggestAppKey,
} from "#lib/create-app-model";

export function CreateAppForm({
  onCreated,
  orgId,
}: {
  onCreated: (appSlug: string) => void;
  orgId: string;
}) {
  const [draft, setDraft] = useState<CreateAppDraft>(emptyAppDraft);
  const [keyEdited, setKeyEdited] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [mutationError, setMutationError] = useState<MutationErrorSurface | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const issues = draftAppIssues(draft);
  const shown = submitted ? issues : [];
  const nameError = appIssueFor(shown, "name");
  const keyError = appIssueFor(shown, "key");

  function edit(next: CreateAppDraft) {
    setDraft(next);
    setMutationError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (issues.length > 0) return;

    setMutationError(null);
    setIsSubmitting(true);
    try {
      const result = await createControlPanelApp({
        data: { orgId, name: draft.name.trim(), key: draft.key.trim() },
      });
      if (result.ok) onCreated(result.data.app.key);
      else setMutationError(mutationErrorSurface(result));
    } catch {
      setMutationError({
        kind: "form",
        message: "The Control Plane could not create this App. Try again.",
        fields: [],
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Create App</DialogTitle>
        <DialogDescription>
          An App groups your Flags and hosts your Experiments. We provision a <code>dev</code> and a{" "}
          <code>prod</code> Environment for it.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="app-name">
          App name
        </label>
        <Input
          aria-invalid={Boolean(nameError)}
          autoComplete="off"
          id="app-name"
          name="name"
          onChange={(event) =>
            edit({
              name: event.target.value,
              key: keyEdited ? draft.key : suggestAppKey(event.target.value),
            })
          }
          placeholder="Checkout API"
          value={draft.name}
        />
        {nameError ? <p className="text-destructive text-xs">{nameError}</p> : null}
      </div>

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="app-key">
          URL slug
        </label>
        <Input
          aria-describedby="app-key-help"
          aria-invalid={Boolean(keyError)}
          autoComplete="off"
          id="app-key"
          name="key"
          onChange={(event) => {
            setKeyEdited(true);
            edit({ ...draft, key: event.target.value });
          }}
          placeholder="checkout-api"
          value={draft.key}
        />
        <p
          className={keyError ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
          id="app-key-help"
        >
          {keyError ?? "Appears in every URL for this App. Unique within the Organization."}
        </p>
      </div>

      {/* The Worker owns the Org role matrix, so its refusal is shown verbatim
          rather than reduced to a generic failure (ADR-0023, ADR-0036). */}
      {mutationError ? (
        <Alert data-testid="create-app-error" variant="destructive">
          <AlertTitle>
            {mutationError.kind === "tier" ? "Not allowed in this Organization" : "App not created"}
          </AlertTitle>
          <AlertDescription>{mutationError.message}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button disabled={isSubmitting} type="submit">
          {isSubmitting ? "Creating…" : "Create App"}
        </Button>
      </DialogFooter>
    </form>
  );
}
