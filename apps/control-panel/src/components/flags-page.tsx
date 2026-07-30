import type { FlagsPageItem } from "#lib/flags-page-data";
import { CreateFlagDialog } from "./create-flag-dialog";
import { FlagsEmptyState } from "./flags-empty-state";
import { FlagsTable } from "./flags-table";
import { FlagsTruncatedNotice } from "./flags-truncated-notice";

type FlagsPageProps = {
  appId: string;
  env: string;
  environmentId: string;
  items: FlagsPageItem[];
  /** Ceiling the Worker's catalog read applied, reported when it actually bound. */
  readLimit: number;
  readTruncated: boolean;
  /** Scope root for the Flag detail links, e.g. `/acme/checkout-api/dev`. */
  scopeHref: string;
};

export function FlagsPage(props: FlagsPageProps) {
  return (
    <section className="grid gap-6" aria-labelledby="flags-title">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
            {props.env} Environment
          </p>
          <h1 className="font-semibold text-3xl text-foreground tracking-tight" id="flags-title">
            Flags
          </h1>
          <p className="max-w-2xl text-muted-foreground text-sm leading-6">
            Each row shows this Environment&apos;s active Flag Configuration.
          </p>
        </div>
        {props.items.length > 0 ? (
          <CreateFlagDialog appId={props.appId} environmentId={props.environmentId} />
        ) : null}
      </header>

      {props.readTruncated ? (
        <FlagsTruncatedNotice readLimit={props.readLimit} shownCount={props.items.length} />
      ) : null}

      {props.items.length === 0 ? (
        <FlagsEmptyState appId={props.appId} environmentId={props.environmentId} />
      ) : (
        <FlagsTable env={props.env} items={props.items} scopeHref={props.scopeHref} />
      )}
    </section>
  );
}
