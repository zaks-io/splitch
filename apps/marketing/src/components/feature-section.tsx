import { SectionEyebrow } from "./section-eyebrow";

const features = [
  {
    title: "Turn features on and off",
    body: "Put a feature behind a Flag, then change its rollout without redeploying your app. Each Environment has its own configuration, so you can test in dev before enabling it in prod.",
  },
  {
    title: "Compare alternatives with an Experiment",
    body: "Test a new model, prompt, or product change against what you use today. Connect user feedback to a Metric and compare the Variants with a confidence interval.",
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
            Two reasons to use splitch
            <span className="text-arm-control">.</span>
          </h2>
          <p className="max-w-md text-muted-foreground leading-relaxed">
            Use Flags when you need a switch. Add an Experiment when you have a question to answer,
            like whether users prefer the responses from a different model.
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
