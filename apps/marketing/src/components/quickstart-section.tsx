import { Button } from "@splitch/ui/components/button";
import { SectionEyebrow } from "./section-eyebrow";

const steps = [
  [
    "Authenticate",
    "Agents connect through the remote MCP OAuth handshake. Humans can use the CLI or panel.",
  ],
  ["Create an App", "dev and prod Environments are provisioned for the common first-run path."],
  [
    "Create a Flag",
    "Define Variants, select dev, and verify one Targeting Key before wiring code.",
  ],
  ["Measure", "Start an Experiment Run and read results against Exposures, not guesses."],
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
          <h2 className="font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            The first run ends on verify, not hope<span className="text-arm-control">.</span>
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Four steps from zero to a measured result. The same quickstart is exposed to agents
            through the MCP resource
            <span className="font-mono text-foreground"> splitch://quickstart</span>.
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

        <div className="flex flex-wrap gap-3">
          <Button render={<a href="/quickstart" />}>Read the quickstart</Button>
          <Button render={<a href="https://mcp.splitch.dev" />} variant="outline">
            Open MCP host
          </Button>
        </div>
      </div>
    </section>
  );
}
