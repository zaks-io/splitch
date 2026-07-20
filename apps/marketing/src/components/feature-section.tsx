const features = [
  {
    title: "Flags and Experiments together",
    body: "Flags control what ships. Experiments measure what changes. splitch keeps both under the App and Environment model so a rollout and an Experiment Run do not drift apart.",
  },
  {
    title: "Agent-first operation",
    body: "The remote MCP server is the primary agent door, with the CLI and panel as first-class skins over the same typed control-plane contract.",
  },
  {
    title: "Edge-shaped serving",
    body: "Evaluation, ingest, analysis, and control-plane Workers stay separate so the serving path can stay fast while authoring remains auditable.",
  },
] as const;

export function FeatureSection() {
  return (
    <section className="border-border border-t bg-muted px-4 py-16 sm:px-6 sm:py-20" id="product">
      <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div className="grid content-start gap-4">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
            Flags + Experiments
          </p>
          <h2 className="max-w-xl font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            One product surface for what ships and what proves it.
          </h2>
        </div>

        <div className="grid gap-4">
          {features.map((feature) => (
            <article
              className="grid gap-2 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6"
              key={feature.title}
            >
              <h3 className="font-display font-semibold text-foreground text-xl">
                {feature.title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">{feature.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
