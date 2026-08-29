import { SectionEyebrow } from "./section-eyebrow";

const features = [
  {
    title: "Flip features without a deploy",
    body: "Roll a Flag out to 10% or 100%, or kill it, and the change hits the edge in seconds. Configured per Environment, so dev and prod never share a switch.",
  },
  {
    title: "The same flag becomes the A/B test",
    body: "Attach an Experiment to a Flag you already shipped. splitch records which Variant each user saw and joins it to your Metrics. No second tool.",
  },
  {
    title: "Metrics you actually run on",
    body: "Conversion, revenue, counts, ratios. Mark the ones that must not get worse as Guardrails. Results come back as a lift with a confidence interval.",
  },
  {
    title: "One call, wherever your code runs",
    body: "evaluate() returns the Variant and records the Exposure in the same round trip. Node, browsers, React, plus Convex and Sentry integrations.",
  },
] as const;

export function FeatureSection() {
  return (
    <section
      className="border-border border-t bg-background px-4 py-16 sm:px-6 sm:py-20"
      id="product"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div className="grid content-start gap-4">
          <SectionEyebrow>Flags + Experiments</SectionEyebrow>
          <h2 className="max-w-xl text-balance font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            Control what ships, then find out if it worked
            <span className="text-arm-control">.</span>
          </h2>
          <p className="max-w-md text-muted-foreground leading-relaxed">
            Most teams buy one tool to flip features and another to measure them. Here it is one
            Flag and one number.
          </p>
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
