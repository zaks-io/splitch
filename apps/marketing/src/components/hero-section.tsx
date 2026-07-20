import { Button } from "@splitch/ui/components/button";
import { SectionEyebrow } from "./section-eyebrow";
import { SplitVisual } from "./split-visual";

export function HeroSection() {
  return (
    <section className="px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <div className="grid gap-7">
          <SectionEyebrow>Feature flags and A/B experimentation, agents first</SectionEyebrow>

          <h1 className="max-w-xl font-bold font-display text-4xl text-foreground tracking-tight sm:text-5xl lg:text-6xl">
            Ship the split<span className="text-arm-control">.</span> Measure the truth
            <span className="text-arm-treatment">.</span>
          </h1>

          <p className="max-w-xl text-lg text-muted-foreground leading-relaxed">
            splitch gives agents and humans one control plane for Flags, Experiments, Environments,
            and Metrics, with rigor built into the workflow instead of bolted on after launch.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button render={<a href="https://app.splitch.dev" />} size="lg">
              Open the panel
            </Button>
            <Button render={<a href="/quickstart" />} size="lg" variant="outline">
              <span aria-hidden="true" className="size-2 rounded-sm bg-arm-treatment" />
              Connect your agent
            </Button>
          </div>

          <p className="font-mono text-muted-foreground text-xs">
            agents connect at mcp.splitch.dev · humans sign in at app.splitch.dev
          </p>
        </div>

        <SplitVisual />
      </div>
    </section>
  );
}
