import { scopedHref } from "#lib/shell/app-shell-navigation";
import type { FlagsPageItem } from "#lib/flags/flags-page-data";
import { CreateFlagDialog } from "#components/flags/create-flag-dialog";
import { EnvironmentSegmentedControl } from "#components/environments/environment-segmented-control";
import { FlagsEmptyState } from "#components/flags/flags-empty-state";
import { FlagsTable } from "#components/flags/flags-table";
import { FlagsTruncatedNotice } from "#components/flags/flags-truncated-notice";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { PanelPageHeader } from "#components/shell/panel-page-header";

type FlagsPageProps = {
  appId: string;
  appSlug: string;
  env: string;
  environments: ReadonlyArray<{ env: string; guarded: boolean }>;
  environmentId: string;
  guarded: boolean;
  orgSlug: string;
  items: FlagsPageItem[];
  /** Ceiling the Worker's catalog read applied, reported when it actually bound. */
  readLimit: number;
  readTruncated: boolean;
  /** Scope root for the Flag detail links, e.g. `/acme/checkout-api/dev`. */
  scopeHref: string;
};

export function FlagsPage(props: FlagsPageProps) {
  return (
    <section aria-labelledby="flags-title">
      <PanelPageHeader
        environmentControl={
          <EnvironmentSegmentedControl
            active={props.env}
            appSlug={props.appSlug}
            environments={props.environments}
            orgSlug={props.orgSlug}
            section="flags"
          />
        }
        actions={
          props.items.length > 0 ? (
            <CreateFlagDialog
              appId={props.appId}
              environmentId={props.environmentId}
              settingsHref={scopedHref(
                { orgSlug: props.orgSlug, appSlug: props.appSlug, env: props.env },
                "settings",
              )}
            />
          ) : undefined
        }
        environment={{ env: props.env, guarded: props.guarded }}
        id="flags-title"
        title="Flags"
      />

      <PanelPageBody className="grid gap-6">
        {props.readTruncated ? (
          <FlagsTruncatedNotice readLimit={props.readLimit} shownCount={props.items.length} />
        ) : null}

        {props.items.length === 0 ? (
          <FlagsEmptyState
            appId={props.appId}
            environmentId={props.environmentId}
            settingsHref={scopedHref(
              { orgSlug: props.orgSlug, appSlug: props.appSlug, env: props.env },
              "settings",
            )}
          />
        ) : (
          <FlagsTable
            appId={props.appId}
            env={props.env}
            environmentId={props.environmentId}
            items={props.items}
            scopeHref={props.scopeHref}
          />
        )}
      </PanelPageBody>
    </section>
  );
}
