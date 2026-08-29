import { CheckIcon } from "lucide-react";
import { SectionEyebrow } from "./section-eyebrow";

const contracts = [
  "Peek at results whenever. Sequential math means early looks can't manufacture a win.",
  "Counts the users who actually saw the Variant, not the ones who might have.",
  "Traffic imbalance, outliers, and many-Metric testing are corrected before you see a number.",
  "Broken config fails loudly with a named error instead of serving a default.",
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
            A result you can act on<span className="text-arm-control">.</span>
          </h2>
          <p className="max-w-xl text-pretty text-muted-foreground leading-relaxed">
            The failure mode of A/B testing is a number that looks like a win and isn’t. The common
            ways to fool yourself are handled for you.
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

          {/* Axis runs 0%..+8%, so every mark sits at value/8: the interval
              [1.1, 7.3] spans 13.75%..91.25% and the +4.2% point estimate lands
              at 52.5%. The heavier rule at 0% is the null: an interval clear of
              it is the whole claim, so the plot has to show that gap. */}
          <div className="grid gap-1.5">
            <div className="relative h-4">
              <span className="-translate-x-1/2 absolute left-[52.5%] font-mono text-foreground text-xs">
                +4.2%
              </span>
            </div>

            <div className="relative h-6">
              <span
                aria-hidden="true"
                className="-translate-y-1/2 absolute inset-x-0 top-1/2 h-px bg-border"
              />
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-0.5 bg-muted-foreground"
              />
              <span
                aria-hidden="true"
                className="-translate-y-1/2 absolute top-1/2 right-[8.75%] left-[13.75%] h-1.5 rounded-full bg-arm-treatment"
              />
              <span
                aria-hidden="true"
                className="absolute inset-y-1 left-[13.75%] w-0.5 rounded-full bg-arm-treatment"
              />
              <span
                aria-hidden="true"
                className="absolute inset-y-1 right-[8.75%] w-0.5 rounded-full bg-arm-treatment"
              />
              <span
                aria-hidden="true"
                className="-translate-x-1/2 absolute inset-y-0 left-[52.5%] w-0.5 rounded-full bg-foreground"
              />
            </div>

            <p className="flex justify-between font-mono text-muted-foreground text-xs">
              <span>0%</span>
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
