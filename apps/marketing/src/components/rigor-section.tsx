import { CheckIcon } from "lucide-react";
import { SectionEyebrow } from "./section-eyebrow";

const contracts = [
  "Sequential, always-valid inference by default",
  "Exposure is the analysis denominator",
  "SRM, CUPED, winsorization, and FDR are product contracts",
  "Bad config fails loud instead of falling back silently",
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
          <h2 className="font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            Results have to trace back to facts<span className="text-arm-control">.</span>
          </h2>
          <p className="max-w-xl text-muted-foreground leading-relaxed">
            splitch treats analysis as an enforced product contract. A result should be auditable
            back to raw Exposure events, the Experiment Run, and the Metric definition that produced
            it.
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
          <p className="flex items-center justify-between font-mono text-muted-foreground text-xs uppercase tracking-wide">
            <span>checkout-conversion · lift</span>
            <span>95% CI</span>
          </p>

          <div className="grid gap-2">
            {/* Axis 0%..+8%; CI [1.1, 7.3] and the +4.2% point estimate sit to scale. */}
            <div className="relative h-8 rounded-md bg-muted">
              <span
                aria-hidden="true"
                className="absolute inset-y-2 right-[9%] left-[14%] rounded-full bg-arm-treatment"
              />
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-[52%] w-1 rounded-full bg-foreground"
              />
            </div>
            <p className="flex justify-between font-mono text-muted-foreground text-xs">
              <span>0%</span>
              <span className="text-foreground">+4.2%</span>
              <span>+8%</span>
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-3 border-border border-t pt-4 font-mono text-sm">
            <div>
              <dt className="text-muted-foreground text-xs uppercase tracking-wide">interval</dt>
              <dd className="mt-1 text-foreground">[1.1, 7.3]</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs uppercase tracking-wide">p-value</dt>
              <dd className="mt-1 text-foreground">0.003</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs uppercase tracking-wide">SRM</dt>
              <dd className="mt-1 text-success-foreground">healthy</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
