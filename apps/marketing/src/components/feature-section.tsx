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
    <section
      className="border-border border-t bg-background px-6 py-20 sm:px-8"
      id="flags-experiments"
    >
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="grid content-start gap-4">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
            Flags + Experiments
          </p>
          <h2 className="max-w-xl font-display font-bold text-4xl text-foreground tracking-tight">
            One product surface for what ships and what proves it.
          </h2>
        </div>

        <div className="grid gap-4">
          {features.map((feature, index) => (
            <article className="feature-row" key={feature.title}>
              <span className="feature-index">0{index + 1}</span>
              <div className="grid gap-2">
                <h3 className="font-display font-semibold text-xl text-foreground">
                  {feature.title}
                </h3>
                <p className="text-muted-foreground leading-relaxed">{feature.body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
