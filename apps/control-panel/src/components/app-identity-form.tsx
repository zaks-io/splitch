import type { App } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { CardContent, CardFooter } from "@splitch/ui/components/card";
import { Input } from "@splitch/ui/components/input";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { type RenameOutcome, renameApp } from "#lib/app-settings-mutations";
import { refreshAppSettings } from "#lib/app-settings-query";
import { appIssueFor, draftAppIssues } from "#lib/create-app-model";
import { AppSessionStaleNotice } from "./app-session-stale-notice";

/**
 * The rename form, validated against the contract's slug rule before it is sent
 * so it cannot accept a key the Worker then rejects. The Worker validates again
 * and owns the refusal, which is shown verbatim (ADR-0023, ADR-0036).
 */
export function AppIdentityForm({
  app,
  env,
  orgSlug,
  slugHelp,
}: {
  app: App;
  /** The two URL segments a slug change does NOT move, so the new URL can be built. */
  env: string;
  orgSlug: string;
  slugHelp: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ name: app.name, key: app.key });
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState<{ reason: string; remedy: "reauth" | "retry" }>();
  const [isSaving, setIsSaving] = useState(false);

  const issues = draftAppIssues(draft);
  const shown = submitted ? issues : [];
  const nameError = appIssueFor(shown, "name");
  const keyError = appIssueFor(shown, "key");
  const isDirty = draft.name !== app.name || draft.key !== app.key;

  // A slug change moves every URL for this App including the one in the address
  // bar, so it navigates rather than leaving the operator on a dead path.
  async function settle(outcome: RenameOutcome) {
    if (outcome.kind === "refused") setError(outcome.message);
    else if (outcome.kind === "stale") setStale(outcome);
    else if (outcome.kind === "moved") {
      globalThis.location.assign(`/${orgSlug}/${outcome.key}/${env}/settings`);
    } else await refreshAppSettings(queryClient, { appId: app.id });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (issues.length > 0) return;

    setError(undefined);
    setStale(undefined);
    setIsSaving(true);
    try {
      await settle(
        await renameApp({
          appId: app.id,
          currentKey: app.key,
          key: draft.key.trim(),
          name: draft.name.trim(),
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={save}>
      <CardContent className="grid gap-5">
        <div className="grid gap-2">
          <label className="font-medium text-sm" htmlFor="app-settings-name">
            App name
          </label>
          <Input
            aria-invalid={Boolean(nameError)}
            autoComplete="off"
            id="app-settings-name"
            name="name"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            value={draft.name}
          />
          {nameError ? <p className="text-destructive text-xs">{nameError}</p> : null}
        </div>

        <div className="grid gap-2">
          <label className="font-medium text-sm" htmlFor="app-settings-key">
            URL slug
          </label>
          <Input
            aria-describedby="app-settings-key-help"
            aria-invalid={Boolean(keyError)}
            autoComplete="off"
            id="app-settings-key"
            name="key"
            onChange={(event) => setDraft({ ...draft, key: event.target.value })}
            value={draft.key}
          />
          <p
            className={keyError ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
            id="app-settings-key-help"
          >
            {keyError ?? slugHelp}
          </p>
        </div>

        {stale ? (
          <AppSessionStaleNotice
            appName={app.name}
            outcome="renamed"
            reason={stale.reason}
            remedy={stale.remedy}
          />
        ) : null}

        {error ? (
          <Alert data-testid="app-rename-error" variant="destructive">
            <AlertTitle>App not renamed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="justify-end">
        <Button disabled={!isDirty || isSaving} type="submit">
          {isSaving ? "Saving…" : "Save App details"}
        </Button>
      </CardFooter>
    </form>
  );
}
