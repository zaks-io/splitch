import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomeRoute,
});

function HomeRoute() {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-5xl content-center gap-10 px-6 py-16">
      <section className="grid gap-5">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
          splitch-marketing
        </p>
        <div className="grid max-w-3xl gap-4">
          <h1 className="font-semibold text-4xl text-foreground leading-tight">splitch</h1>
          <p className="max-w-2xl text-base text-muted-foreground leading-relaxed">
            Unified feature flags and A/B experimentation for agent-operated Apps.
          </p>
        </div>
      </section>

      <Card className="max-w-2xl" data-theme-token-smoke="primary">
        <CardHeader>
          <CardTitle>Marketing Worker scaffold</CardTitle>
          <CardDescription>
            Static home route prerendered with TanStack Start and served by its own Worker.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button type="button" variant="secondary">
            Health
          </Button>
          <Button disabled type="button" variant="outline">
            Landing content next
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
