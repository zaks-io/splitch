import type { ClientKey } from "@splitch/contracts";
import {
  renderConnectSnippet,
  renderServerConnectSnippet,
  SDK_INSTALL_COMMAND,
} from "#lib/connect/connect-snippet";
import { parityHint } from "#lib/connect/parity-hints";
import {
  type FlagImplementationInput,
  renderFlagImplementationPrompt,
} from "#lib/connect/implementation-prompt";
import { CodeAgentPrompt } from "#components/connect/code-agent-prompt";
import { CopyableCode } from "#components/connect/copyable-code";

const CLIENT_KEY_PARITY = parityHint("client_key_get");

/**
 * Step 4 of the visual quickstart (screen-inventory.md#onboarding): everything
 * needed to make the Flag you just created resolve from your own code.
 *
 * The Client Key is a public credential and is shown in full. The API Key is
 * not: it is displayed exactly once at creation and is never redisplayed
 * (ADR-0022), so the server snippet reads it from the environment and the
 * trusted-server path is a link to Settings rather than a second key on screen.
 */
export function ConnectYourCodeCard({
  clientKey,
  flag,
  flagKey,
  settingsHref,
}: {
  clientKey: ClientKey;
  flag?: FlagImplementationInput["flag"];
  flagKey: string;
  settingsHref: string;
}) {
  return (
    <div className="grid gap-5" data-testid="connect-your-code">
      <CopyableCode
        label="Client Key (public, for browser and mobile)"
        testId="connect-client-key"
        value={clientKey.keyMaterial}
        wrap
      />

      {flag ? (
        <CodeAgentPrompt
          prompt={renderFlagImplementationPrompt({
            clientKey: clientKey.keyMaterial,
            flag,
          })}
          testId="flag-code-agent-prompt"
        />
      ) : null}

      <CopyableCode label="Install" testId="connect-install" value={SDK_INSTALL_COMMAND} />

      <CopyableCode
        label="Resolve the Flag"
        testId="connect-snippet"
        value={renderConnectSnippet({ clientKey: clientKey.keyMaterial, flagKey })}
      />

      <details className="rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer font-medium text-sm">
          Running on a trusted server instead?
        </summary>
        <div className="grid gap-3 pt-3">
          <p className="text-muted-foreground text-sm leading-6">
            A server holds a secret API Key, which returns richer resolution reasons than the public
            Client Key. Provision one under{" "}
            <a className="underline underline-offset-4" href={settingsHref}>
              Environment settings
            </a>
            . It is shown once at creation and never again, so store it as a secret at that moment.
          </p>
          <CopyableCode
            label="Server snippet"
            testId="connect-server-snippet"
            value={renderServerConnectSnippet({ flagKey })}
          />
        </div>
      </details>

      <p className="text-muted-foreground text-sm leading-6">
        Prefer the terminal or an agent? <code>{CLIENT_KEY_PARITY.cli}</code> /{" "}
        <code>{CLIENT_KEY_PARITY.mcp}</code> returns the same Client Key.
      </p>
    </div>
  );
}
