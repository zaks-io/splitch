import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { Input } from "@splitch/ui/components/input";
import type { ClientKey } from "@splitch/contracts";
import { useState } from "react";
import { lockControlPanelClientKey } from "#lib/control-plane-settings-functions";

interface ClientKeyCardProps {
  appId: string;
  environmentId: string;
  initialClientKey: ClientKey;
}

export function ClientKeyCard({ appId, environmentId, initialClientKey }: ClientKeyCardProps) {
  const [clientKey, setClientKey] = useState(initialClientKey);
  const [origins, setOrigins] = useState("");
  const [copyLabel, setCopyLabel] = useState("Copy");
  const [error, setError] = useState<string>();
  const [isLocking, setIsLocking] = useState(false);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(clientKey.keyMaterial);
      setCopyLabel("Copied");
    } catch {
      setError("The browser could not copy the Client Key. Select and copy it manually.");
    }
  }

  async function lockToOrigins() {
    const originAllowlist = parseOrigins(origins);
    if (!originAllowlist.ok) {
      setError(originAllowlist.message);
      return;
    }
    setError(undefined);
    setIsLocking(true);
    try {
      const result = await lockControlPanelClientKey({
        data: { appId, environmentId, originAllowlist: originAllowlist.values },
      });
      if (result.ok) {
        setClientKey(result.data);
        setOrigins("");
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("The Client Key could not be locked. Its open state has not changed.");
    } finally {
      setIsLocking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client Key</CardTitle>
        <CardDescription>
          Public credential for browser and mobile SDKs in this Environment.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <code
            className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs"
            data-testid="client-key"
          >
            {clientKey.keyMaterial}
          </code>
          <Button onClick={copyKey} type="button" variant="outline">
            {copyLabel}
          </Button>
        </div>

        {clientKey.isOriginOpen ? (
          <Alert className="border-warning bg-warning-muted">
            <AlertTitle>This Client Key accepts requests from any origin</AlertTitle>
            <AlertDescription>
              Lock it to the exact origins that run your client-side SDK.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="rounded-lg border border-border p-3">
            <p className="font-medium text-sm">Locked origins</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {clientKey.originAllowlist?.join(", ")}
            </p>
          </div>
        )}

        {clientKey.isOriginOpen ? (
          <div className="grid gap-2">
            <label className="font-medium text-sm" htmlFor="client-key-origins">
              Allowed origins
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-describedby="client-key-origins-help"
                id="client-key-origins"
                onChange={(event) => {
                  setOrigins(event.target.value);
                  setError(undefined);
                }}
                placeholder="https://app.example.com, https://admin.example.com"
                value={origins}
              />
              <Button disabled={isLocking} onClick={lockToOrigins} type="button">
                {isLocking ? "Locking…" : "Lock to origins"}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs" id="client-key-origins-help">
              Comma-separated HTTPS origins. Paths are removed.
            </p>
          </div>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Client Key remains open</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function parseOrigins(
  value: string,
): { ok: true; values: string[] } | { ok: false; message: string } {
  const candidates = value
    .split(/[,\n]/u)
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    return { ok: false, message: "Enter at least one origin before locking this key." };
  }
  try {
    const values = candidates.map((candidate) => {
      const url = new URL(candidate);
      if (url.protocol !== "https:" && url.hostname !== "localhost") {
        throw new Error("insecure origin");
      }
      return url.origin;
    });
    return { ok: true, values: [...new Set(values)] };
  } catch {
    return { ok: false, message: "Enter valid HTTPS origins, such as https://app.example.com." };
  }
}
