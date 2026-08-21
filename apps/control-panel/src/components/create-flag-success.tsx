import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { parityHint } from "#lib/parity-hints";
import { exposureStatusDisplayState } from "#lib/exposure-status-polling";
import { environmentExposureStatusQuery } from "#lib/exposure-status-query";
import { environmentSettingsQuery } from "#lib/settings-query";
import { ConnectYourCodeCard } from "./connect-your-code-card";
import { EnvironmentExposureStatus } from "./environment-exposure-status";
import { FlagVerifyPanel } from "./flag-verify-panel";

const CLIENT_KEY_PARITY = parityHint("client_key_get");

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
  settingsHref,
}: {
  appId: string;
  environmentId: string;
  flagKey: string;
  settingsHref: string;
}) {
  const settings = useQuery(environmentSettingsQuery({ appId, environmentId }));
  const exposureStatus = useQuery(environmentExposureStatusQuery({ appId, environmentId }));
  const exposureDisplayState = exposureStatusDisplayState(exposureStatus);

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
            to copy the Client Key, or run <code>{CLIENT_KEY_PARITY.cli}</code>.
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

      {exposureDisplayState === "loading" ? <EnvironmentExposureStatus state="loading" /> : null}
      {exposureDisplayState === "error" ? (
        <EnvironmentExposureStatus
          onRetry={() => {
            void exposureStatus.refetch();
          }}
          state="error"
        />
      ) : null}
      {exposureDisplayState === "not_received" ? (
        <EnvironmentExposureStatus state="not_received" />
      ) : null}
      {exposureDisplayState === "received" && exposureStatus.data?.state === "received" ? (
        <EnvironmentExposureStatus
          firstExposureAt={exposureStatus.data.firstExposureAt}
          state="received"
        />
      ) : null}

      <DialogFooter showCloseButton />
    </div>
  );
}
