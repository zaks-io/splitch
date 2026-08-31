import type { App, ResourceDeleteBlocker } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { Input } from "@splitch/ui/components/input";
import { useState } from "react";
import { AppDeleteConsequenceList } from "#components/apps/app-delete-consequence-list";
import { AppSessionStaleNotice } from "#components/sessions/app-session-stale-notice";
import { isDeleteConfirmed } from "#lib/apps/app-delete-confirmation";
import { deleteConsequences } from "#lib/apps/app-delete-consequences";
import { type DeleteOutcome, destroyApp } from "#lib/apps/app-settings-mutations";

type DeleteError = { message: string; partial: boolean; reload: boolean; title?: string };

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
  onPartialDelete,
}: {
  app: App;
  blockers: readonly ResourceDeleteBlocker[];
  environmentNames: readonly string[];
  onCancel: () => void;
  onPartialDelete: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<DeleteError>();
  const [stale, setStale] = useState<{ reason: string; remedy: "reauth" | "retry" }>();
  const [isDeleting, setIsDeleting] = useState(false);

  const consequences = deleteConsequences(blockers);
  const confirmed = isDeleteConfirmed(typed, app.key);

  async function settle(outcome: DeleteOutcome) {
    if (outcome.kind === "refused") {
      setError({ message: outcome.message, partial: false, reload: false });
      return;
    }
    if (outcome.kind === "cleanup-pending") {
      setError({
        message: `${outcome.message} The App was deleted, but cleanup did not finish. Retry deletion to finish cleanup.`,
        partial: true,
        reload: false,
        title: "App cleanup incomplete",
      });
      return;
    }
    if (outcome.kind === "partially-deleted") {
      setError(await partialDeleteError(outcome, onPartialDelete));
      return;
    }
    if (outcome.kind === "stale") setStale(outcome);
    else globalThis.location.assign("/");
  }

  async function destroy() {
    if (!confirmed) return;
    setError(undefined);
    setStale(undefined);
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
          <AlertTitle>
            {error.title ?? (error.partial ? "App partially deleted" : "App not deleted")}
          </AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>{error.message}</p>
            {error.reload ? (
              <Button onClick={() => globalThis.location.reload()} type="button" variant="outline">
                Reload page
              </Button>
            ) : null}
          </AlertDescription>
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
          disabled={!confirmed || isDeleting || error?.reload === true}
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

async function partialDeleteError(
  outcome: Extract<DeleteOutcome, { kind: "partially-deleted" }>,
  refresh: () => Promise<unknown>,
): Promise<DeleteError> {
  try {
    await refresh();
    return {
      message: `${outcome.message} The App remains, but ${outcome.removedCount} ${outcome.removedCount === 1 ? "resource was" : "resources were"} deleted before the operation stopped. This page was refreshed.`,
      partial: true,
      reload: false,
    };
  } catch {
    return {
      message: `${outcome.message} The App may or may not have been deleted, and some resources were deleted before the operation stopped. Reload this page before retrying.`,
      partial: true,
      reload: true,
    };
  }
}
