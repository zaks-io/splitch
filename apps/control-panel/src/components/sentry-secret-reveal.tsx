import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { useState } from "react";

/**
 * The signing secret, shown once.
 *
 * Same once-only treatment as a provisioned API Key, because it is the same
 * promise: splitch stores only the sealed copy, so this render is the only place
 * the value exists in readable form. It has to be pasted into Sentry's
 * Add-Provider form before it is dismissed.
 */
export function SentrySecretReveal({
  secret,
  onDismiss,
  onCopyFailed,
}: {
  secret: string;
  onDismiss: () => void;
  onCopyFailed: (message: string) => void;
}) {
  const [copyLabel, setCopyLabel] = useState("Copy signing secret");

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyLabel("Copied");
    } catch {
      onCopyFailed("The browser could not copy the signing secret. Select and copy it manually.");
    }
  }

  return (
    <Alert className="border-warning bg-warning-muted">
      <AlertTitle>Copy this signing secret now</AlertTitle>
      <AlertDescription>
        Paste it into the Secret field of Sentry's Add New Provider form. This is the only time
        splitch will show it.
        <code
          className="mt-2 block overflow-x-auto rounded-md bg-background px-3 py-2 text-foreground text-xs"
          data-testid="once-only-sentry-secret"
        >
          {secret}
        </code>
        <span className="mt-2 flex flex-wrap gap-2">
          <Button onClick={copySecret} size="sm" type="button" variant="outline">
            {copyLabel}
          </Button>
          <Button onClick={onDismiss} size="sm" type="button">
            I saved it
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
