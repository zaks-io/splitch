import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import type { PanelApiKeyMetadata } from "@splitch/control-plane-sdk/panel-settings";
import { useState } from "react";
import {
  loadControlPanelSettings,
  provisionControlPanelApiKey,
  revokeControlPanelApiKey,
} from "#lib/control-plane-settings-functions";

interface ApiKeysCardProps {
  appId: string;
  environmentId: string;
  initialApiKeys: PanelApiKeyMetadata[];
}

interface OnceOnlySecret {
  keyId: string;
  value: string;
}

export function ApiKeysCard({ appId, environmentId, initialApiKeys }: ApiKeysCardProps) {
  const [apiKeys, setApiKeys] = useState(initialApiKeys);
  const [secret, setSecret] = useState<OnceOnlySecret>();
  const [copyLabel, setCopyLabel] = useState("Copy API Key");
  const [error, setError] = useState<string>();
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string>();

  async function provision() {
    setError(undefined);
    setIsProvisioning(true);
    try {
      const created = await provisionControlPanelApiKey({ data: { appId, environmentId } });
      if (!created.ok) {
        setError(created.error.message);
        return;
      }
      setSecret({ keyId: created.data.credential.keyId, value: created.data.value });
      const refreshed = await loadControlPanelSettings({ data: { appId, environmentId } });
      if (refreshed.ok) setApiKeys(refreshed.data.apiKeys);
      else setError("The API Key was created, but its metadata could not be refreshed.");
    } catch {
      setError("The API Key could not be provisioned. Try again.");
    } finally {
      setIsProvisioning(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setCopyLabel("Copied");
    } catch {
      setError("The browser could not copy the API Key. Select and copy it manually now.");
    }
  }

  async function revoke(keyId: string) {
    if (
      !window.confirm(
        `Revoke API Key ${keyId}? It will stop working immediately and cannot be restored.`,
      )
    ) {
      return;
    }
    setError(undefined);
    setRevokingKeyId(keyId);
    try {
      const result = await revokeControlPanelApiKey({ data: { appId, environmentId, keyId } });
      if (result.ok) setApiKeys(result.data.apiKeys);
      else setError(result.error.message);
    } catch {
      setError("Revocation did not complete. The API Key may still be active.");
    } finally {
      setRevokingKeyId(undefined);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Keys</CardTitle>
        <CardDescription>
          Secret credentials for trusted server-side SDKs. Existing values cannot be recovered.
        </CardDescription>
        <CardAction>
          <Button disabled={isProvisioning} onClick={provision} type="button">
            {isProvisioning ? "Provisioning…" : "Provision API Key"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {secret ? (
          <Alert className="border-warning bg-warning-muted">
            <AlertTitle>Copy this API Key now</AlertTitle>
            <AlertDescription>
              This is the only time splitch will show the full value.
              <code
                className="mt-2 block overflow-x-auto rounded-md bg-background px-3 py-2 text-foreground text-xs"
                data-testid="once-only-api-key"
              >
                {secret.value}
              </code>
              <span className="mt-2 flex flex-wrap gap-2">
                <Button onClick={copySecret} size="sm" type="button" variant="outline">
                  {copyLabel}
                </Button>
                <Button
                  onClick={() => {
                    setSecret(undefined);
                    setCopyLabel("Copy API Key");
                  }}
                  size="sm"
                  type="button"
                >
                  I saved it
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>API Key operation failed loud</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hash prefix</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
              <TableHead aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {apiKeys.length === 0 ? (
              <TableRow>
                <TableCell className="text-muted-foreground" colSpan={5}>
                  No API Keys provisioned for this Environment.
                </TableCell>
              </TableRow>
            ) : (
              apiKeys.map((key) => (
                <TableRow data-api-key-id={key.keyId} key={key.keyId}>
                  <TableCell>
                    <code className="text-xs">sha256:{key.keyHashPrefix}…</code>
                    <span className="mt-1 block text-muted-foreground text-xs">{key.keyId}</span>
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal">
                    {key.scopes.join(", ")}
                  </TableCell>
                  <TableCell>{key.createdAt.slice(0, 10)}</TableCell>
                  <TableCell>
                    <Badge variant={key.revokedAt ? "secondary" : "default"}>
                      {key.revokedAt ? "Revoked" : "Active"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      disabled={Boolean(key.revokedAt) || revokingKeyId === key.keyId}
                      onClick={() => revoke(key.keyId)}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      {revokingKeyId === key.keyId ? "Revoking…" : "Revoke"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
