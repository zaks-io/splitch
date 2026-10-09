import { Button } from "@splitch/ui/components/button";
import { devSession } from "../content/agent-session";
import { CliTranscript } from "./cli-transcript";
import { InstallTabs } from "./install-tabs";
import { SectionEyebrow } from "./section-eyebrow";

export function HeroSection() {
  return (
    <section className="px-4 py-14 sm:px-6 sm:py-20">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14">
        <div className="grid min-w-0 gap-7">
          <SectionEyebrow>Built for coding agents</SectionEyebrow>

          <h1 className="text-balance font-bold font-display text-4xl text-foreground tracking-tight sm:text-5xl xl:text-[3.5rem] xl:leading-[1.05]">
            <span className="lg:block">
              Control what ships<span className="text-arm-control">.</span>
            </span>{" "}
            <span className="lg:block">
              Learn what works<span className="text-arm-treatment">.</span>
            </span>
          </h1>

          <p className="max-w-lg text-lg text-muted-foreground leading-relaxed">
            Feature flags and A/B experiments your coding agent can create, promote, and measure end
            to end.
          </p>

          <InstallTabs />

          <div className="flex flex-wrap items-center gap-5">
            <Button render={<a href="/quickstart" />} size="lg">
              Set up a feature flag
            </Button>
            <a
              className="font-medium text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
              href="/docs/code-agents"
            >
              Read the agent guide
            </a>
          </div>
        </div>

        <CliTranscript session={devSession} />
      </div>
    </section>
  );
}
