import { SectionEyebrow } from "./section-eyebrow";

/* Each guarantee maps to an enforced contract in docs/vision.md (ADR-0010,
   0014, 0015, 0016), not a setting a user can switch off. */
const guarantees = [
  {
    title: "Look whenever you like",
    body: "Sequential, always-valid tests are the default, so checking a running Experiment does not inflate false positives.",
  },
  {
    title: "Count who actually saw it",
    body: "The denominator is deduplicated first Exposures, computed from the raw event log rather than a rollup.",
  },
  {
    title: "Catch a broken split",
    body: "A sample ratio mismatch check flags uneven traffic before you trust the comparison.",
  },
  {
    title: "Tighter intervals",
    body: "CUPED and winsorization run by default when the data supports them, with variance computed per randomization unit.",
  },
] as const;

export function RigorSection() {
  return (
    <section
      className="border-border border-t bg-background px-4 py-16 sm:px-6 sm:py-24"
      id="rigor"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-12">
        <div className="grid max-w-[65ch] gap-4">
          <SectionEyebrow>Statistical rigor</SectionEyebrow>
          <h2 className="text-balance font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            See the difference, and the uncertainty.
          </h2>
          <p className="text-muted-foreground text-lg leading-relaxed">
            An Experiment can show an improvement, a regression, or an inconclusive result. splitch
            tells you which, with the interval behind it.
          </p>
        </div>

        <ul className="grid gap-x-12 gap-y-8 sm:grid-cols-2">
          {guarantees.map((guarantee) => (
            <li
              className="grid content-start gap-2 border-border border-t pt-5"
              key={guarantee.title}
            >
              <h3 className="font-display font-semibold text-foreground text-lg">
                {guarantee.title}
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{guarantee.body}</p>
            </li>
          ))}
        </ul>

        <p className="max-w-[65ch] border-arm-treatment border-l-2 pl-4 text-muted-foreground leading-relaxed">
          <span className="font-medium text-foreground">We use it ourselves.</span> In Neuron, one
          of our own apps, splitch compares a newer, cheaper model against the current one using
          user feedback. An inconclusive result does not mean the models perform equally, so we keep
          collecting.
        </p>
      </div>
    </section>
  );
}
