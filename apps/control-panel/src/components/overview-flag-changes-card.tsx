import type { OverviewFlagConfigChange } from "@splitch/contracts";
import { Badge } from "@splitch/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { changedAtLabel } from "#lib/overview-view";
import { FlagChangesTruncatedNotice } from "./flag-changes-truncated-notice";

export function OverviewFlagChangesCard({
  changedCount,
  readLimit,
  readTruncated,
  recentlyChanged,
  scopeHref,
  windowDays,
}: {
  changedCount: number;
  readLimit: number;
  readTruncated: boolean;
  recentlyChanged: readonly OverviewFlagConfigChange[];
  scopeHref: string;
  windowDays: number;
}) {
  // Measured against what this card actually renders, not against the server's
  // display cap, so the notice can only appear when changes really are missing
  // from the list below it.
  const truncated = readTruncated || changedCount > recentlyChanged.length;

  return (
    <Card data-overview-card="flag-changes">
      <CardHeader>
        <CardTitle>Recently changed Flag Configuration</CardTitle>
        <CardDescription>
          {/* No audit trail exists yet (SPL-161), so this reports what changed and
              when, and deliberately attributes it to nobody. */}
          Changed in this Environment in the last {windowDays} days. Who made each change is not
          recorded yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {truncated ? (
          <FlagChangesTruncatedNotice
            changedCount={changedCount}
            readLimit={readLimit}
            readTruncated={readTruncated}
            scopeHref={scopeHref}
            shownCount={recentlyChanged.length}
            windowDays={windowDays}
          />
        ) : null}
        {/* The empty line is a claim about the Environment, and a truncated scan
            cannot support it. The server cannot produce this pair, but nothing
            stops a caller from constructing it, and "more than 50 changed" sitting
            above "nothing changed" is worse than showing neither. */}
        {recentlyChanged.length === 0 && !truncated ? (
          <p className="text-muted-foreground text-sm">
            No Flag Configuration changed in the last {windowDays} days.
          </p>
        ) : (
          <ul className="grid gap-2">
            {recentlyChanged.map((change) => (
              <li key={change.flagId}>
                <a
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
                  data-overview-flag={change.flagKey}
                  href={`${scopeHref}/flags/${encodeURIComponent(change.flagKey)}`}
                >
                  <span className="font-medium font-mono text-foreground">{change.flagKey}</span>
                  <span className="flex items-center gap-2">
                    <Badge variant={change.enabled ? "default" : "secondary"}>
                      {change.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    <time className="text-muted-foreground text-xs" dateTime={change.updatedAt}>
                      {changedAtLabel(change.updatedAt)}
                    </time>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
