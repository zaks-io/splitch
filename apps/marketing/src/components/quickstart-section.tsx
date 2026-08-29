import { Button } from "@splitch/ui/components/button";
import { SectionEyebrow } from "./section-eyebrow";

const steps = [
  ["Create an App", "Environments and keys for dev and prod come with it."],
  ["Create a Flag", "Name it, give it Variants, enable it, set the rollout."],
  ["Verify", "A real round trip on your credential, before you touch code."],
  ["Wire one call", "evaluate() returns the Variant and records the Exposure."],
] as const;

export function QuickstartSection() {
  return (
    <section
      className="border-border border-t bg-muted px-4 py-16 sm:px-6 sm:py-20"
      id="quickstart"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-10">
        <div className="grid max-w-3xl gap-4">
          <SectionEyebrow>Quickstart</SectionEyebrow>
          <h2 className="max-w-2xl text-balance font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            Four steps, and the third one is proof
            <span className="text-arm-control">.</span>
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            You confirm the setup works before writing any application code.
          </p>
        </div>

        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map(([title, body], index) => (
            <li
              className="grid content-start gap-2.5 rounded-xl border border-border bg-card p-5 shadow-xs"
              key={title}
            >
              <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
                Step {index + 1}
              </p>
              <h3 className="font-display font-semibold text-foreground text-lg">{title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-5">
          <Button render={<a href="/quickstart" />}>Set up a feature flag</Button>
          <a
            className="font-medium text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
            href="/docs"
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}
