import { Button } from "@splitch/ui/components/button";

/* The section's top edge is the Split itself: cobalt into chartreuse, doing the
   job a border would. Structure, not decoration, which is why the name note at
   the foot of the section can point at it. */
export function CtaSection() {
  return (
    <section className="bg-background">
      <div aria-hidden="true" className="grid h-1 grid-cols-2">
        <span className="bg-arm-control" />
        <span className="bg-arm-treatment" />
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-16 sm:px-6 sm:py-20">
        <div className="grid gap-4">
          <h2 className="max-w-3xl text-balance font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            Your next feature can ship behind a flag today
            <span className="text-arm-treatment">.</span>
          </h2>
          <p className="max-w-2xl text-muted-foreground leading-relaxed">
            About a minute with the CLI, or hand it to your agent.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-5">
          <Button render={<a href="/quickstart" />} size="lg">
            Set up a feature flag
          </Button>
          <a
            className="font-medium text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
            href="#agents"
          >
            Connect your agent
          </a>
        </div>

        <p className="mt-4 max-w-3xl border-border border-t pt-6 text-muted-foreground text-sm leading-relaxed">
          <span className="font-medium text-foreground">Why splitch?</span>{" "}
          <span className="font-semibold text-arm-control">Split</span> testing and feature swit
          <span className="font-semibold text-arm-treatment-foreground">ch</span>es, fused into one
          word.
        </p>
      </div>
    </section>
  );
}
