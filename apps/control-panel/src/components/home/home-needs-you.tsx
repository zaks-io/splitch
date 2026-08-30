import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { ATTENTION_DOT_CLASSES } from "#components/shell/environment-link";
import type { NeedsYouItem } from "#lib/home/home-needs-you";

export function HomeNeedsYou({
  emptyCopy,
  items,
  measuredClear,
}: {
  emptyCopy: string;
  items: readonly NeedsYouItem[];
  measuredClear: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs you</CardTitle>
        <CardDescription>Experiment health across Apps</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length > 0 ? (
          <div className="grid gap-4">
            {items.map((item) => (
              <article
                className="grid gap-2 border-border border-b pb-4 last:border-0 last:pb-0"
                data-needs-you-item
                data-severity={item.severity}
                key={`${item.appSlug}:${item.env}`}
              >
                <p className="flex items-center gap-2 font-mono font-medium text-foreground text-sm">
                  <span
                    aria-hidden="true"
                    className={`size-2 shrink-0 rounded-full ${ATTENTION_DOT_CLASSES[item.severity]}`}
                  />
                  {item.appSlug} / {item.env}
                </p>
                <p className="text-muted-foreground text-sm leading-5">{item.reason}</p>
                <div>
                  <Button
                    render={
                      <a
                        aria-label={`Open ${item.appSlug} ${item.environmentName}`}
                        href={item.href}
                      />
                    }
                    size="sm"
                    variant="outline"
                  >
                    Open
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : measuredClear ? (
          <p
            className="rounded-lg border border-border bg-success-muted p-3 text-sm text-success-foreground leading-6"
            data-needs-you-clear
          >
            {emptyCopy}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm leading-6">{emptyCopy}</p>
        )}
      </CardContent>
    </Card>
  );
}
