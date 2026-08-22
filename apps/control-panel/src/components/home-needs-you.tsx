import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import type { NeedsYouItem } from "#lib/home-needs-you";

export function HomeNeedsYou({ items }: { items: readonly NeedsYouItem[] }) {
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
                <p className="font-mono font-medium text-foreground text-sm">
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
        ) : (
          <p className="text-muted-foreground text-sm leading-6">
            Nothing needs you. Experiment health is clear in every Environment.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
