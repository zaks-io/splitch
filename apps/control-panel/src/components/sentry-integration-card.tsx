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
import {
  installSentry,
  revokeSentryInstallation,
  rotateSentrySecret,
  type SentryOutcome,
} from "#lib/sentry-mutations";
import { refreshSentryInstallations, sentryInstallationsQuery } from "#lib/sentry-query";
import { SentryInstallForm } from "./sentry-install-form";
import { SentryInstallationsTable } from "./sentry-installations-table";
import { SentrySecretReveal } from "./sentry-secret-reveal";

/**
 * Connecting an Environment to Sentry's Generic feature-flag provider.
 *
 * splitch is the provider, and Sentry's form only accepts a pasted signing
 * secret, so the exchange is two-way: Sentry's webhook URL comes in here, and
 * the secret splitch mints goes back there. The secret is shown once.
 */
export function SentryIntegrationCard({
  appId,
  environmentId,
}: {
  appId: string;
  environmentId: string;
}) {
  const queryClient = useQueryClient();
  const scope = { appId, environmentId };
  const installations = useQuery(sentryInstallationsQuery(scope));
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [busyInstallationId, setBusyInstallationId] = useState<string>();
  const [isInstalling, setIsInstalling] = useState(false);

  const hasActiveInstallation = (installations.data ?? []).some(
    (installation) => installation.status === "active",
  );

  async function settle(outcome: SentryOutcome, refreshFailure: string) {
    if (outcome.kind === "refused") {
      setError(outcome.message);
      return;
    }
    if (outcome.kind === "secret") setSecret(outcome.value);
    try {
      await refreshSentryInstallations(queryClient, scope);
    } catch {
      setError(refreshFailure);
    }
  }

  async function install(webhookUrl: string) {
    setError(undefined);
    setIsInstalling(true);
    try {
      const outcome = await installSentry({
        ...scope,
        installationId: crypto.randomUUID(),
        webhookUrl,
      });
      await settle(outcome, "Sentry was connected, but its status could not be refreshed.");
    } catch {
      setError("Sentry could not be connected. Try again.");
    } finally {
      setIsInstalling(false);
    }
  }

  async function rotate(installationId: string) {
    setError(undefined);
    setBusyInstallationId(installationId);
    try {
      const outcome = await rotateSentrySecret({
        ...scope,
        installationId,
        rotationId: crypto.randomUUID(),
      });
      await settle(
        outcome,
        "The signing secret was rotated, but the status could not be refreshed.",
      );
    } catch {
      setError("The signing secret could not be rotated. The previous one is still in force.");
    } finally {
      setBusyInstallationId(undefined);
    }
  }

  async function revoke(installationId: string) {
    if (
      !window.confirm(
        "Disconnect Sentry? Flag changes in this Environment will stop reaching its flag audit log.",
      )
    ) {
      return;
    }
    setError(undefined);
    // The reveal says "this is the only time splitch will show it". Leaving it
    // on screen next to a row that now reads Revoked presents a dead secret as
    // a live one.
    setSecret(undefined);
    setBusyInstallationId(installationId);
    try {
      const outcome = await revokeSentryInstallation({ ...scope, installationId });
      await settle(outcome, "Sentry was disconnected, but the status could not be refreshed.");
    } catch {
      setError("Sentry could not be disconnected. It may still be receiving Flag changes.");
    } finally {
      setBusyInstallationId(undefined);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sentry change tracking</CardTitle>
        <CardDescription>
          Publishes every Flag change in this Environment to Sentry's flag audit log, so an error
          can be traced to the toggle that preceded it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {secret ? (
          <SentrySecretReveal
            onCopyFailed={setError}
            onDismiss={() => setSecret(undefined)}
            secret={secret}
          />
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Sentry operation failed loud</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {installations.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Sentry status unavailable</AlertTitle>
            <AlertDescription>{installations.error.message}</AlertDescription>
          </Alert>
        ) : installations.isPending ? (
          <p className="text-muted-foreground text-sm">Loading Sentry status…</p>
        ) : (
          <>
            <SentryInstallationsTable
              busyInstallationId={busyInstallationId}
              installations={installations.data}
              onRevoke={revoke}
              onRotate={rotate}
            />
            {hasActiveInstallation ? null : (
              <SentryInstallForm isSubmitting={isInstalling} onSubmit={install} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
