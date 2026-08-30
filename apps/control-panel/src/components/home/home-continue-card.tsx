import { Button } from "@splitch/ui/components/button";
import { Card } from "@splitch/ui/components/card";
import { AppSplitMark } from "#components/shared/app-split-mark";
import { appSectionRegistry, destinationSection } from "#lib/shell/app-shell-navigation";
import { formatRelativeTime, type LastVisitedEntry } from "#lib/sessions/last-visited-scope";

export function HomeContinueCard({ entry, now }: { entry: LastVisitedEntry; now: number }) {
  return (
    <Card className="flex-row items-center px-(--card-spacing) max-sm:flex-wrap" data-continue-card>
      <AppSplitMark />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          Continue where you left off
        </p>
        <p className="truncate font-mono text-foreground text-sm">
          {entry.env === null
            ? `${entry.appSlug} · Flags across Environments`
            : `${entry.appSlug} / ${entry.env} · ${sectionLabel(entry.section)}`}
        </p>
      </div>
      <p className="shrink-0 text-muted-foreground text-sm">{formatRelativeTime(now, entry.at)}</p>
      <Button render={<a data-continue-path href={entry.path} />}>Resume</Button>
    </Card>
  );
}

function sectionLabel(section: string): string {
  if (section === "") return "Overview";
  const destination = appSectionRegistry.find(
    (candidate) => destinationSection(candidate.to) === section,
  );
  return destination ? destination.label : section;
}
