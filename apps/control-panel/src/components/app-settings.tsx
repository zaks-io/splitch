import type { PanelAppSettings } from "@splitch/control-plane-sdk/panel-app-settings";
import { appSettingsCapabilities } from "#lib/app-settings-capabilities";
import { AppCatalogCard } from "./app-catalog-card";
import { AppDangerZone } from "./app-danger-zone";
import { AppIdentityCard } from "./app-identity-card";
import { AppMembersCard } from "./app-members-card";
import { AppSetupCard } from "./app-setup-card";

/**
 * The App half of Settings. Everything here is App-level and stays the same in
 * every Environment; the Environment tab owns what changes per Environment.
 *
 * Capabilities come from `settings.viewerRole`, which the Worker read live while
 * authorizing this read. The Worker rechecks it again on every mutation and owns
 * every refusal — this only decides what to offer.
 */
export function AppSettings({
  env,
  environmentId,
  environmentNames,
  orgSlug,
  settings,
}: {
  env: string;
  environmentId: string;
  environmentNames: readonly string[];
  orgSlug: string;
  settings: PanelAppSettings;
}) {
  const scopeHref = `/${orgSlug}/${settings.app.key}/${env}`;
  const capabilities = appSettingsCapabilities(settings.viewerRole);

  return (
    <div className="grid gap-6" data-app-settings={settings.app.id}>
      <header>
        <p className="text-muted-foreground text-xs uppercase tracking-wide">App settings</p>
        <h1 className="mt-1 font-semibold text-2xl">{settings.app.name}</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Identity, access, and Flag catalog for this App. These apply in every Environment.
        </p>
      </header>
      <AppSetupCard
        appHomeHref={`/${orgSlug}/${settings.app.key}`}
        appId={settings.app.id}
        env={env}
        environmentId={environmentId}
        environmentSettingsHref={`${scopeHref}/settings/environment`}
        firstFlagKey={settings.flags.items[0]?.key}
      />
      <AppIdentityCard
        app={settings.app}
        canRename={capabilities.canRename}
        env={env}
        orgSlug={orgSlug}
      />
      <AppCatalogCard catalog={settings.flags} scopeHref={scopeHref} />
      <AppMembersCard
        appId={settings.app.id}
        candidates={settings.candidates}
        candidatesWithheld={settings.candidatesWithheld}
        capabilities={capabilities}
        members={settings.members}
      />
      {capabilities.canDelete ? (
        <AppDangerZone app={settings.app} environmentNames={environmentNames} />
      ) : null}
    </div>
  );
}
