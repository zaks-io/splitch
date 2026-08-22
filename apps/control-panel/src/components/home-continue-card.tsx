import { Button } from "@splitch/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { appSectionRegistry, destinationSection } from "#lib/app-shell-navigation";
import { formatRelativeTime, type LastVisitedEntry } from "#lib/last-visited-scope";

export function HomeContinueCard({ entry, now }: { entry: LastVisitedEntry; now: number }) {
  return (
    <Card data-continue-card>
      <CardHeader>
        <CardTitle>Continue where you left off</CardTitle>
        <CardAction>
          <Button render={<a data-continue-path href={entry.path} />} variant="outline">
            Resume
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-1">
        <p className="font-mono text-foreground text-sm">
          {entry.env === null
            ? `${entry.appSlug} · Flags across Environments`
            : `${entry.appSlug} / ${entry.env} · ${sectionLabel(entry.section)}`}
        </p>
        <p className="text-muted-foreground text-sm">{formatRelativeTime(now, entry.at)}</p>
      </CardContent>
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
