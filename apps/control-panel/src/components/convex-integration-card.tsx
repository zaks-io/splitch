import type { ConvexInstallationStatus } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { revokeConvexInstallation } from "#lib/convex-mutations";
import { convexInstallationsQuery, refreshConvexInstallations } from "#lib/convex-query";
import { CopyableCode } from "./copyable-code";
import { PushInstallationsTable, type PushInstallationRow } from "./push-installations-table";

const CONVEX_LABELS = {
  provider: "convex",
  destinationHeading: "Convex endpoint",
  emptyMessage: "This Environment is not connected to a Convex deployment.",
  syncedVersionLabel: "Delivered",
} as const;

export function ConvexIntegrationCard({
  appId,
  environmentId,
}: {
  appId: string;
  environmentId: string;
}) {
  const queryClient = useQueryClient();
  const scope = { appId, environmentId };
  const installations = useQuery(convexInstallationsQuery(scope));
  const [error, setError] = useState<string>();
  const [busyInstallationId, setBusyInstallationId] = useState<string>();
  const hasActiveInstallation = (installations.data ?? []).some((row) => row.status === "active");

  async function revoke(installationId: string) {
    if (
      !window.confirm(
        "Disconnect Convex? Flag and Experiment configuration will stop syncing to this Convex deployment.",
      )
    ) {
      return;
    }
    setError(undefined);
    setBusyInstallationId(installationId);
    try {
      const outcome = await revokeConvexInstallation({ ...scope, installationId });
      if (outcome.kind === "refused") {
        setError(outcome.message);
        return;
      }
      try {
        await refreshConvexInstallations(queryClient, scope);
      } catch {
        setError("Convex was disconnected, but its status could not be refreshed.");
      }
    } catch {
      setError("Convex could not be disconnected. It may still be receiving configuration.");
    } finally {
      setBusyInstallationId(undefined);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Convex configuration sync</CardTitle>
        <CardDescription>
          This Environment's Flag and Experiment configuration is pushed to the splitch Convex
          Component so Convex functions evaluate locally.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Convex operation failed loud</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {installations.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Convex status unavailable</AlertTitle>
            <AlertDescription>{installations.error.message}</AlertDescription>
          </Alert>
        ) : installations.isPending ? (
          <p className="text-muted-foreground text-sm">Loading Convex status…</p>
        ) : (
          <>
            <PushInstallationsTable
              busyInstallationId={busyInstallationId}
              labels={CONVEX_LABELS}
              onRevoke={revoke}
              rows={installations.data.map(convexRow)}
            />
            {hasActiveInstallation ? null : <ConvexSetupSteps />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function convexRow(installation: ConvexInstallationStatus): PushInstallationRow {
  return {
    installationId: installation.installationId,
    destinationUrl: installation.callbackUrl,
    environmentVersion: installation.environmentVersion,
    syncedVersion: installation.lastDeliveredVersion,
    status: installation.status,
    pendingCount: installation.pendingCount,
    oldestPendingAgeMs: installation.oldestPendingAgeMs,
    terminalCount: installation.terminalCount,
    latestDeliveryError: installation.latestDeliveryError,
  };
}

function ConvexSetupSteps() {
  return (
    <div className="grid gap-5" data-testid="convex-setup-steps">
      <p className="text-muted-foreground text-sm leading-6">
        The Convex Component registers itself from your deployment. Set it up in the project that
        owns these functions.
      </p>
      <CopyableCode
        label="Install the component"
        testId="convex-component-install"
        value="npm install @splitch/convex"
      />
      <CopyableCode
        label="Mount in convex/convex.config.ts"
        testId="convex-component-mount"
        value={
          'app.use(splitch, {\n  httpPrefix: "/integrations/splitch/",\n  env: { SPLITCH_API_KEY: app.env.SPLITCH_API_KEY },\n});'
        }
      />
      <p className="text-muted-foreground text-sm leading-6">
        Set this Environment's <code>SPLITCH_API_KEY</code> in the Convex deployment, deploy, then
        call <code>flags.install(ctx)</code> once from an Action.
      </p>
    </div>
  );
}
