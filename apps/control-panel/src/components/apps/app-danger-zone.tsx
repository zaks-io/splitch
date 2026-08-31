import type { App } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppDeleteCeremony } from "#components/apps/app-delete-ceremony";
import { refreshAppSettings } from "#lib/apps/app-settings-query";
import { deleteControlPanelApp } from "#lib/apps/control-plane-app-settings-functions";

/**
 * Deleting an App is owner-only and irreversible, so the button here opens the
 * confirmation ceremony rather than performing anything.
 *
 * Opening it runs a dry run first: the ceremony has to name exactly what will be
 * destroyed, and the only source of truth for that is the Control Plane's own
 * blocker tree. A dry run destroys nothing.
 */
export function AppDangerZone({
  app,
  environmentNames,
}: {
  app: App;
  environmentNames: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof deleteControlPanelApp>>>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  async function openCeremony() {
    setError(undefined);
    setIsLoading(true);
    try {
      const result = await deleteControlPanelApp({ data: { appId: app.id, dryRun: true } });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setPreview(result);
    } catch {
      setError("The Control Plane could not report what this App contains. Nothing was deleted.");
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshAfterPartialDelete() {
    await refreshAppSettings(queryClient, { appId: app.id });
    const result = await deleteControlPanelApp({ data: { appId: app.id, dryRun: true } });
    if (!result.ok) throw new Error(result.error.message);
    setPreview(result);
  }

  const blockers = preview?.ok && "blockers" in preview.data ? preview.data.blockers : undefined;

  return (
    <Card className="border-destructive" data-testid="app-danger-zone">
      <CardHeader>
        <CardTitle className="text-destructive">Delete this App</CardTitle>
        <CardDescription>
          Permanent. Every Environment, Flag, Experiment, and SDK credential in this App goes with
          it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? (
          <Alert data-testid="app-delete-error" variant="destructive">
            <AlertTitle>App not deleted</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {blockers ? (
          <AppDeleteCeremony
            app={app}
            blockers={blockers}
            environmentNames={environmentNames}
            onCancel={() => setPreview(undefined)}
            onPartialDelete={refreshAfterPartialDelete}
          />
        ) : (
          <div>
            <Button
              data-testid="app-delete-open"
              disabled={isLoading}
              onClick={openCeremony}
              type="button"
              variant="destructive"
            >
              {isLoading ? "Checking what this App contains…" : "Delete this App…"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
