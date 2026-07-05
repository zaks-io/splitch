import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

const service = "splitch-control-panel";
const demoScope = {
  orgSlug: "demo-org",
  appSlug: "checkout-api",
  env: "dev",
};

export const Route = createFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const [clicks, setClicks] = useState(0);

  return (
    <main className="grid gap-6">
      <section className="grid gap-4">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">{service}</p>
        <div className="grid gap-2">
          <h1 className="font-semibold text-3xl text-foreground">Control Panel</h1>
          <p className="max-w-2xl text-base text-muted-foreground">
            App and Environment scoped authoring for feature flags and A/B experimentation.
          </p>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Unauthenticated shell</CardTitle>
          <CardDescription>
            Organization, App, and Environment scope are URL-visible from the first route slice.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-5">
          <div
            className="rounded-md border border-primary/30 bg-accent p-4 text-accent-foreground shadow-sm"
            data-theme-token-smoke="primary"
          >
            <p className="font-medium text-sm">Control Variant</p>
            <p className="text-sm">Reference Variant for preview.</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              data-hydration-counter={clicks}
              onClick={() => setClicks((currentClicks) => currentClicks + 1)}
              type="button"
            >
              Clicks {clicks}
            </Button>
            <Button
              render={<Link params={demoScope} to="/$orgSlug/$appSlug/$env" />}
              variant="outline"
            >
              Open demo scope
            </Button>
            <Button render={<Link to="/kitchen-sink" />} variant="secondary">
              Open kitchen sink
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
