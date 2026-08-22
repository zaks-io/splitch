import { useRouter } from "@tanstack/react-router";
import { appHomeHref, scopedHref } from "#lib/app-shell-navigation";
import { createDelegationEnvironment, type FlagsMatrixData } from "#lib/flags-matrix-data";
import type { EnvironmentScope } from "#lib/loader-context";
import { CreateFlagDialog } from "./create-flag-dialog";
import { EnvironmentSegmentedControl } from "./environment-segmented-control";
import { FlagCreatedNotice } from "./flag-created-notice";
import { FlagsEmptyState } from "./flags-empty-state";
import { FlagsMatrixTable } from "./flags-matrix-table";
import { FlagsTruncatedNotice } from "./flags-truncated-notice";
import { PanelPageHeader } from "./panel-page-header";

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
          matrix.rows.length > 0 ? (
            <CreateFlagDialog
              appId={appId}
              environmentId={delegation.environmentId}
              onClosedAfterCreate={showCreatedFlag}
              settingsHref={settingsHref}
            />
          ) : null
        }
        crumb={appSlug}
        id="flags-title"
        title="Flags"
      />
      <div className="grid gap-6 px-8 py-6">
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
      </div>
    </section>
  );
}
