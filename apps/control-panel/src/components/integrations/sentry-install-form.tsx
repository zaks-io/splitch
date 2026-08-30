import { Button } from "@splitch/ui/components/button";
import { Input } from "@splitch/ui/components/input";
import { Label } from "@splitch/ui/components/label";
import { type FormEvent, useId, useState } from "react";

/**
 * Sentry's Add New Provider form shows the webhook URL it will accept and asks
 * for a secret it does not issue. So the operator starts there, brings the URL
 * here, and carries the minted secret back. The instructions spell that order
 * out because getting it backwards leaves a half-configured provider in Sentry.
 */
export function SentryInstallForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting: boolean;
  onSubmit: (webhookUrl: string) => void;
}) {
  const inputId = useId();
  const [webhookUrl, setWebhookUrl] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(webhookUrl.trim());
  }

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <div className="grid gap-2">
        <Label htmlFor={inputId}>Sentry webhook URL</Label>
        <Input
          autoComplete="off"
          id={inputId}
          onChange={(event) => setWebhookUrl(event.target.value)}
          placeholder="https://<org>.sentry.io/api/0/organizations/<org>/flags/hooks/provider/generic/"
          type="url"
          value={webhookUrl}
        />
        <p className="text-muted-foreground text-xs">
          In Sentry, open Settings, Feature Flags, Add New Provider, and choose Generic. Copy the
          webhook URL it shows into this field. splitch answers with a signing secret to paste back
          into that form's Secret field.
        </p>
      </div>
      <div>
        <Button disabled={isSubmitting || webhookUrl.trim().length === 0} type="submit">
          {isSubmitting ? "Connecting…" : "Connect Sentry"}
        </Button>
      </div>
    </form>
  );
}
