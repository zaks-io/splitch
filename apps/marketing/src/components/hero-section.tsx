import { Button } from "@splitch/ui/components/button";
import { CodeSnippet } from "./code-snippet";
import { SectionEyebrow } from "./section-eyebrow";
import { SplitVisual } from "./split-visual";

export function HeroSection() {
  return (
    <section className="px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <div className="grid gap-7">
          <SectionEyebrow>Feature flags and experiments, built for agents</SectionEyebrow>

          <h1 className="max-w-2xl text-balance font-bold font-display text-4xl text-foreground tracking-tight sm:text-5xl lg:text-6xl">
            Control what ships<span className="text-arm-control">.</span> Learn what works
            <span className="text-arm-treatment">.</span>
          </h1>

          <p className="max-w-lg text-lg text-muted-foreground leading-relaxed">
            Turn features on or off without redeploying your app. Run A/B experiments to measure how
            changes affect your users. Your coding agent can manage both through the CLI.
          </p>

          <CodeSnippet
            code={`npm install --global @splitch/cli
splitch login
splitch context --json`}
          />

          <div className="flex flex-wrap items-center gap-5">
            <Button render={<a href="/quickstart" />} size="lg">
              Set up a feature flag
            </Button>
            <a
              className="font-medium text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
              href="#agents"
            >
              Use your coding agent
            </a>
          </div>
        </div>

        <SplitVisual />
      </div>
    </section>
  );
}
