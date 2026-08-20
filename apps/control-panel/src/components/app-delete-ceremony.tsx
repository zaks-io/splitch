import type { App, ResourceDeleteBlocker } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { Input } from "@splitch/ui/components/input";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { isDeleteConfirmed } from "#lib/app-delete-confirmation";
import { deleteConsequences } from "#lib/app-delete-consequences";
import { type DeleteOutcome, destroyApp } from "#lib/app-settings-mutations";
import { refreshAppSettings } from "#lib/app-settings-query";
import { AppDeleteConsequenceList } from "./app-delete-consequence-list";
import { AppSessionStaleNotice } from "./app-session-stale-notice";

/**
 * The typed confirmation. The operator must type this App's URL slug exactly;
 * nothing here deletes on a single click, and the list above the input names
 * every resource that goes with it.
 *
 * The slug is the right thing to type: it is what the operator sees in the
 * address bar and what they would have to get right to reach this screen at all,
 * so a muscle-memory match is impossible in a way a "yes" or a checkbox is not.
 */
export function AppDeleteCeremony({
  app,
  blockers,
  environmentNames,
  onCancel,
}: {
  app: App;
  blockers: readonly ResourceDeleteBlocker[];
  environmentNames: readonly string[];
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState<{ reason: string; remedy: "reauth" | "retry" }>();
  const [pending, setPending] = useState<string[]>();
  const [isDeleting, setIsDeleting] = useState(false);

  const consequences = deleteConsequences(blockers);
  const confirmed = isDeleteConfirmed(typed, app.key);

  async function settle(outcome: DeleteOutcome) {
    if (outcome.kind === "refused") setError(outcome.message);
    else if (outcome.kind === "review") {
      setPending(outcome.reviewCommands);
      // The cascade already removed part of the App; the cards above render
      // from the same settings query and must not keep showing what is gone.
      try {
        await refreshAppSettings(queryClient, { appId: app.id });
      } catch {
        setError(
          "Part of this App was removed, but this screen could not reload. Reload the page to see what remains.",
        );
      }
    } else if (outcome.kind === "stale") setStale(outcome);
    else globalThis.location.assign("/");
  }

  async function destroy() {
    if (!confirmed) return;
    setError(undefined);
    setStale(undefined);
    setPending(undefined);
    setIsDeleting(true);
    try {
      await settle(await destroyApp(app.id));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="grid gap-4" data-testid="app-delete-ceremony">
      <AppDeleteConsequenceList consequences={consequences} environmentNames={environmentNames} />

      {pending ? (
        <Alert data-testid="app-delete-pending-approvals" variant="destructive">
          <AlertTitle>Deletion stopped for Review</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>
              Part of this App was removed. The rest is gated by Environment Policy and now has
              Approval Requests waiting. Nothing else is deleted until they are reviewed.
            </span>
            {pending.map((command) => (
              <code className="block break-words text-xs" key={command}>
                {command}
              </code>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {stale ? (
        <AppSessionStaleNotice
          appName={app.name}
          outcome="deleted"
          reason={stale.reason}
          remedy={stale.remedy}
        />
      ) : null}

      {error ? (
        <Alert data-testid="app-delete-error" variant="destructive">
          <AlertTitle>App not deleted</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="app-delete-confirm">
          Type <code className="rounded bg-muted px-1 py-0.5">{app.key}</code> to confirm
        </label>
        <Input
          aria-describedby="app-delete-confirm-help"
          autoComplete="off"
          data-testid="app-delete-confirm"
          id="app-delete-confirm"
          onChange={(event) => setTyped(event.target.value)}
          value={typed}
        />
        <p className="text-muted-foreground text-xs" id="app-delete-confirm-help">
          The URL slug of the App you are deleting.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={isDeleting} onClick={onCancel} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          data-testid="app-delete-submit"
          disabled={!confirmed || isDeleting}
          onClick={destroy}
          type="button"
          variant="destructive"
        >
          {isDeleting ? "Deleting…" : `Delete ${app.name} and everything in it`}
        </Button>
      </div>
    </div>
  );
}
