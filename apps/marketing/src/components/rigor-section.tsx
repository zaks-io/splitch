import { CheckIcon } from "lucide-react";
import { SectionEyebrow } from "./section-eyebrow";

const contracts = [
  "Sequential analysis supports checking results while an Experiment runs.",
  "Results use recorded Exposures to count who encountered each Variant.",
  "Traffic imbalance checks flag problems that can make a comparison unreliable.",
  "Confidence intervals show the uncertainty around the measured difference.",
] as const;

export function RigorSection() {
  return (
    <section
      className="border-border border-t bg-background px-4 py-16 sm:px-6 sm:py-20"
      id="rigor"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-2 lg:items-center">
        <div className="grid gap-5">
          <SectionEyebrow>Statistical rigor</SectionEyebrow>
          <h2 className="text-balance font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            See the difference, and the uncertainty<span className="text-arm-control">.</span>
          </h2>
          <p className="max-w-xl text-pretty text-muted-foreground leading-relaxed">
            An Experiment can show an improvement, a regression, or an inconclusive result. How much
            you can learn depends on the feedback you collect and the size of the effect.
          </p>
          <ul className="grid gap-3">
            {contracts.map((contract) => (
              <li className="flex items-start gap-3 text-foreground text-sm" key={contract}>
                <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                {contract}
              </li>
            ))}
          </ul>
        </div>

        <div className="grid gap-4 rounded-xl border border-border bg-card p-5 shadow-md sm:p-6">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
            In practice
          </p>
          <h3 className="font-display font-semibold text-foreground text-xl">
            Is a cheaper model worth switching to?
          </h3>
          <p className="text-muted-foreground leading-relaxed">
            In Neuron, we use splitch to compare a newer, cheaper model with the model we have been
            using. Users provide feedback on the responses, which we measure in an Experiment.
          </p>
          <p className="border-border border-t pt-4 text-muted-foreground text-sm leading-relaxed">
            The question is whether user feedback differs between the models. An inconclusive result
            does not establish that they perform equally well.
          </p>
        </div>
      </div>
    </section>
  );
}
