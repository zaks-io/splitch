import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { environmentSettingsQuery } from "#lib/settings-query";
import { ConnectYourCodeCard } from "./connect-your-code-card";
import { FlagVerifyPanel } from "./flag-verify-panel";

/**
 * The guided SDK handoff shown immediately after a Flag is created
 * (screen-inventory.md#onboarding, steps 4-6). One concept per block: get the
 * credential and the snippet, prove the Flag resolves, then go fire a real
 * Evaluation from your own code.
 */
export function CreateFlagSuccess({
  appId,
  environmentId,
  flagKey,
}: {
  appId: string;
  environmentId: string;
  flagKey: string;
}) {
  const params = useParams({ strict: false });
  const settingsHref = `/${params.orgSlug}/${params.appSlug}/${params.env}/settings`;
  const settings = useQuery(environmentSettingsQuery({ appId, environmentId }));

  return (
    <div className="grid max-h-[75vh] gap-5 overflow-y-auto" data-testid="create-flag-success">
      <DialogHeader>
        <DialogTitle>Connect your code</DialogTitle>
        <DialogDescription>
          <code>{flagKey}</code> was created with the boolean Variant catalog.
        </DialogDescription>
      </DialogHeader>

      {settings.isPending ? (
        <p className="text-muted-foreground text-sm leading-6">Loading your Client Key…</p>
      ) : null}

      {settings.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Your Client Key could not be loaded</AlertTitle>
          <AlertDescription>
            The Flag was created. Open{" "}
            <a className="underline underline-offset-4" href={settingsHref}>
              Environment settings
            </a>{" "}
            to copy the Client Key, or run <code>splitch client-key get</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      {settings.data ? (
        <>
          <ConnectYourCodeCard
            clientKey={settings.data.clientKey}
            flagKey={flagKey}
            settingsHref={settingsHref}
          />
          <FlagVerifyPanel appId={appId} environmentId={environmentId} flagKey={flagKey} />
        </>
      ) : null}

      <p className="text-muted-foreground text-sm leading-6" data-testid="first-exposure-nudge">
        Last step: run your app so it calls <code>evaluate()</code> for real. That is the first
        Exposure, and it is what onboarding is actually waiting on. The test above deliberately does
        not count.
      </p>

      <DialogFooter showCloseButton />
    </div>
  );
}
