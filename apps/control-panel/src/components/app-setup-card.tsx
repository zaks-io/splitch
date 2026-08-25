import type { ClientKey } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { SDK_INSTALL_COMMAND } from "#lib/connect-snippet";
import { exposureStatusDisplayState } from "#lib/exposure-status-polling";
import { environmentExposureStatusQuery } from "#lib/exposure-status-query";
import { parityHint } from "#lib/parity-hints";
import { environmentSettingsQuery } from "#lib/settings-query";
import { ConnectYourCodeCard } from "./connect-your-code-card";
import { CopyableCode } from "./copyable-code";
import { EnvironmentExposureStatus } from "./environment-exposure-status";

const CLIENT_KEY_PARITY = parityHint("client_key_get");

/**
 * The same guided SDK handoff as the create-Flag success dialog, permanently
 * findable from Settings. It renders until this Environment records its first
 * Exposure, then removes itself: once real Evaluations arrive, setup is done
 * and the Environment tab remains the durable home for credentials.
 */
export function AppSetupCard({
  appHomeHref,
  appId,
  env,
  environmentId,
  environmentSettingsHref,
  firstFlagKey,
}: {
  appHomeHref: string;
  appId: string;
  env: string;
  environmentId: string;
  environmentSettingsHref: string;
  firstFlagKey: string | undefined;
}) {
  const settings = useQuery(environmentSettingsQuery({ appId, environmentId }));
  const exposureStatus = useQuery(environmentExposureStatusQuery({ appId, environmentId }));
  const exposureDisplayState = exposureStatusDisplayState(exposureStatus);
  if (exposureDisplayState === "received") return null;

  return (
    <Card data-testid="app-setup-card">
      <CardHeader>
        <CardTitle>Connect your code</CardTitle>
        <CardDescription>
          The <code>{env}</code> Environment has not received an Evaluation yet. Wire the SDK in
          with the Client Key below; this card goes away once data starts flowing.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {settings.isPending ? (
          <p className="text-muted-foreground text-sm leading-6">Loading your Client Key…</p>
        ) : null}

        {settings.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Your Client Key could not be loaded</AlertTitle>
            <AlertDescription>
              Open{" "}
              <a className="underline underline-offset-4" href={environmentSettingsHref}>
                Environment settings
              </a>{" "}
              to copy the Client Key, or run <code>{CLIENT_KEY_PARITY.cli}</code>.
            </AlertDescription>
          </Alert>
        ) : null}

        {settings.data ? (
          firstFlagKey ? (
            <ConnectYourCodeCard
              clientKey={settings.data.clientKey}
              flagKey={firstFlagKey}
              settingsHref={environmentSettingsHref}
            />
          ) : (
            <FirstFlagNudge appHomeHref={appHomeHref} clientKey={settings.data.clientKey} />
          )
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
      </CardContent>
    </Card>
  );
}

/**
 * With zero Flags there is no honest resolution snippet to show, so hand over
 * the credential and the install command and point at Flag creation, which
 * hands over the full snippet on success.
 */
function FirstFlagNudge({ appHomeHref, clientKey }: { appHomeHref: string; clientKey: ClientKey }) {
  return (
    <div className="grid gap-5" data-testid="app-setup-first-flag-nudge">
      <CopyableCode
        label="Client Key (public, for browser and mobile)"
        testId="connect-client-key"
        value={clientKey.keyMaterial}
        wrap
      />
      <CopyableCode label="Install" testId="connect-install" value={SDK_INSTALL_COMMAND} />
      <p className="text-muted-foreground text-sm leading-6">
        This App has no Flags yet.{" "}
        <a className="underline underline-offset-4" href={appHomeHref}>
          Create your first Flag
        </a>{" "}
        to get the resolution snippet for your code.
      </p>
    </div>
  );
}
