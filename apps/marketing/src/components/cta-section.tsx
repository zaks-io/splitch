import { Button } from "@splitch/ui/components/button";

/* The one inverted band: ink surface in both modes, with the split rule on
   top carrying the duotone at full saturation. */
export function CtaSection() {
  return (
    <section className="bg-neutral-950 px-4 py-16 text-neutral-50 sm:px-6 sm:py-20">
      <div
        aria-hidden="true"
        className="mx-auto mb-14 grid h-1 w-full max-w-6xl grid-cols-2 overflow-hidden rounded-full"
      >
        <span className="bg-arm-control" />
        <span className="bg-arm-treatment" />
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="grid gap-4">
          <h2 className="max-w-3xl font-bold font-display text-3xl tracking-tight sm:text-4xl">
            Give agents the same flag and experiment surface humans get.
          </h2>
          <p className="max-w-2xl text-neutral-400 leading-relaxed">
            Start in the panel, then let agents operate through MCP with typed tools and the same
            authority model.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button render={<a href="https://app.splitch.dev" />} size="lg">
            Open the panel
          </Button>
          <Button
            className="border-neutral-700 bg-transparent text-neutral-50 hover:bg-neutral-900 hover:text-white"
            render={<a href="/quickstart" />}
            size="lg"
            variant="outline"
          >
            Connect your agent
          </Button>
        </div>
      </div>
    </section>
  );
}
