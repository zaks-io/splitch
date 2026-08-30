import { type CloudflareInstallationStatus, cliPresentationAliasString } from "@splitch/contracts";
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
import { revokeCloudflareInstallation } from "#lib/integrations/cloudflare-mutations";
import {
  cloudflareInstallationsQuery,
  refreshCloudflareInstallations,
} from "#lib/integrations/cloudflare-query";
import { renderCloudflareIntegrationPrompt } from "#lib/connect/implementation-prompt";
import { CodeAgentPrompt } from "#components/connect/code-agent-prompt";
import { CopyableCode } from "#components/connect/copyable-code";
import {
  PushInstallationsTable,
  type PushInstallationRow,
} from "#components/integrations/push-installations-table";

/** Derived, never typed: the CLI registers this exact path from the same map. */
const CLOUDFLARE_SETUP_COMMAND = cliPresentationAliasString("cloudflare_installations_create");

const CLOUDFLARE_LABELS = {
  provider: "cloudflare",
  destinationHeading: "Worker endpoint",
  emptyMessage: "This Environment is not connected to a Cloudflare Worker.",
  syncedVersionLabel: "Applied",
} as const;

export function CloudflareIntegrationCard({
  appId,
  environmentId,
  environmentKey,
}: {
  appId: string;
  environmentId: string;
  environmentKey: string;
}) {
  const queryClient = useQueryClient();
  const scope = { appId, environmentId };
  const installations = useQuery(cloudflareInstallationsQuery(scope));
  const [error, setError] = useState<string>();
  const [busyInstallationIds, setBusyInstallationIds] = useState<ReadonlySet<string>>(new Set());
  const hasActiveInstallation = (installations.data ?? []).some((row) => row.status === "active");

  async function revoke(installationId: string) {
    if (
      !window.confirm(
        "Disconnect Cloudflare? Configuration will stop syncing to this Worker, which will keep its last applied version.",
      )
    ) {
      return;
    }
    setError(undefined);
    setBusyInstallationIds((busy) => new Set(busy).add(installationId));
    try {
      const outcome = await revokeCloudflareInstallation({ ...scope, installationId });
      if (outcome.kind === "refused") {
        setError(outcome.message);
        return;
      }
      try {
        await refreshCloudflareInstallations(queryClient, scope);
      } catch {
        setError("Cloudflare was disconnected, but its status could not be refreshed.");
      }
    } catch {
      setError("Cloudflare could not be disconnected. It may still be receiving configuration.");
    } finally {
      setBusyInstallationIds((busy) => {
        const next = new Set(busy);
        next.delete(installationId);
        return next;
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cloudflare Worker sync</CardTitle>
        <CardDescription>
          Pushes this Environment's Flag and Experiment configuration to a Worker in your Cloudflare
          account for local evaluation through a service binding.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Cloudflare operation failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {installations.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Cloudflare status unavailable</AlertTitle>
            <AlertDescription>{installations.error.message}</AlertDescription>
          </Alert>
        ) : installations.isPending ? (
          <p className="text-muted-foreground text-sm">Loading Cloudflare status…</p>
        ) : (
          <>
            <PushInstallationsTable
              busyInstallationIds={busyInstallationIds}
              labels={CLOUDFLARE_LABELS}
              onRevoke={revoke}
              rows={installations.data.map(cloudflareRow)}
            />
            {hasActiveInstallation ? null : (
              <CloudflareSetupSteps environmentKey={environmentKey} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function cloudflareRow(installation: CloudflareInstallationStatus): PushInstallationRow {
  return {
    installationId: installation.installationId,
    destinationUrl: installation.endpoint,
    environmentVersion: installation.environmentVersion,
    syncedVersion: installation.lastAppliedVersion,
    status: installation.status,
    pendingCount: installation.pendingCount,
    oldestPendingAgeMs: installation.oldestPendingAgeMs,
    terminalCount: installation.terminalCount,
    latestDeliveryError: installation.latestDeliveryError,
  };
}

function CloudflareSetupSteps({ environmentKey }: { environmentKey: string }) {
  return (
    <div className="grid gap-5" data-testid="cloudflare-setup-steps">
      <p className="text-muted-foreground text-sm leading-6">
        Run setup from the Worker's project directory. It requires Wrangler 4 and uses that
        project's authenticated Cloudflare account.
      </p>
      <CopyableCode
        label="Set up Cloudflare"
        testId="cloudflare-setup-command"
        value={`${CLOUDFLARE_SETUP_COMMAND} --env ${environmentKey}`}
      />
      <CodeAgentPrompt
        prompt={renderCloudflareIntegrationPrompt(environmentKey)}
        testId="cloudflare-code-agent-prompt"
        title="Implement Cloudflare with your code agent"
      />
    </div>
  );
}
