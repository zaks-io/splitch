import type { PanelEnvironmentSettings } from "@splitch/control-plane-sdk/panel-settings";
import { ApiKeysCard } from "./api-keys-card";
import { ClientKeyCard } from "./client-key-card";
import { CloudflareIntegrationCard } from "./cloudflare-integration-card";
import { ConvexIntegrationCard } from "./convex-integration-card";
import { EnvironmentPolicyEditor } from "./environment-policy-editor";

export function EnvironmentSettings({ settings }: { settings: PanelEnvironmentSettings }) {
  const scope = { appId: settings.environment.appId, environmentId: settings.environment.id };
  return (
    <div className="grid gap-6" data-environment-settings={settings.environment.id}>
      <header>
        <p className="text-muted-foreground text-xs uppercase tracking-wide">
          Environment settings
        </p>
        <h1 className="mt-1 font-semibold text-2xl">{settings.environment.name}</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          SDK credentials and change Policy for{" "}
          <code className="rounded bg-muted px-1 py-0.5">{settings.environment.key}</code>.
        </p>
      </header>
      <ClientKeyCard {...scope} initialClientKey={settings.clientKey} />
      <ApiKeysCard {...scope} initialApiKeys={settings.apiKeys} />
      <EnvironmentPolicyEditor {...scope} initialPolicy={settings.environment.policy} />
      <ConvexIntegrationCard {...scope} />
      <CloudflareIntegrationCard {...scope} environmentKey={settings.environment.key} />
    </div>
  );
}
