import { Button } from "@splitch/ui/components/button";
import { useRouter } from "@tanstack/react-router";
import { appHomeHref, scopedHref } from "#lib/shell/app-shell-navigation";
import { createDelegationEnvironment, type FlagsMatrixData } from "#lib/flags/flags-matrix-data";
import type { EnvironmentScope } from "#lib/shared/loader-context";
import { CreateFlagDialog } from "#components/flags/create-flag-dialog";
import { EnvironmentSegmentedControl } from "#components/environments/environment-segmented-control";
import { FlagCreatedNotice } from "#components/flags/flag-created-notice";
import { FlagsEmptyState } from "#components/flags/flags-empty-state";
import { FlagsMatrixTable } from "#components/flags/flags-matrix-table";
import { FlagsTruncatedNotice } from "#components/flags/flags-truncated-notice";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { PanelPageHeader } from "#components/shell/panel-page-header";
import { RouterAnchor } from "#components/shell/shell-menu";

export function FlagsMatrixPage({
  appId,
  appSlug,
  createdKey,
  environments,
  matrix,
  orgSlug,
}: {
  orgSlug: string;
  appSlug: string;
  appId: string;
  environments: readonly EnvironmentScope[];
  matrix: FlagsMatrixData;
  createdKey?: string;
}) {
  const router = useRouter();
  const delegation = createDelegationEnvironment(environments);
  const settingsHref = scopedHref({ orgSlug, appSlug, env: delegation.env }, "settings");

  function showCreatedFlag(key: string) {
    void router.navigate({
      to: appHomeHref({ orgSlug, appSlug }) as never,
      search: { created: key } as never,
    });
  }

  return (
    <section aria-labelledby="flags-title">
      <PanelPageHeader
        environmentControl={
          <EnvironmentSegmentedControl
            active="all"
            appSlug={appSlug}
            environments={environments}
            orgSlug={orgSlug}
            section="flags"
          />
        }
        actions={
          <>
            <Button
              render={<RouterAnchor href={settingsHref}>Settings</RouterAnchor>}
              variant="outline"
            />
            {matrix.rows.length > 0 ? (
              <CreateFlagDialog
                appId={appId}
                environmentId={delegation.environmentId}
                onClosedAfterCreate={showCreatedFlag}
                settingsHref={settingsHref}
              />
            ) : null}
          </>
        }
        crumb="App"
        id="flags-title"
        title={appSlug}
      />
      <PanelPageBody className="grid gap-6">
        {matrix.readTruncated ? (
          <FlagsTruncatedNotice readLimit={matrix.readLimit} shownCount={matrix.rows.length} />
        ) : null}
        {createdKey ? (
          <FlagCreatedNotice
            appSlug={appSlug}
            createdKey={createdKey}
            matrix={matrix}
            orgSlug={orgSlug}
          />
        ) : null}
        {matrix.rows.length === 0 ? (
          <FlagsEmptyState
            appId={appId}
            environmentId={delegation.environmentId}
            onClosedAfterCreate={showCreatedFlag}
            settingsHref={settingsHref}
          />
        ) : (
          <FlagsMatrixTable
            appId={appId}
            appSlug={appSlug}
            createdKey={createdKey}
            delegationEnvironment={delegation}
            environments={environments}
            matrix={matrix}
            orgSlug={orgSlug}
          />
        )}
      </PanelPageBody>
    </section>
  );
}
