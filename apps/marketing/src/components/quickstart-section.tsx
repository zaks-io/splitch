import { CtaLink } from "./cta-link";

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
    <section className="border-border border-t bg-background px-6 py-20 sm:px-8" id="quickstart">
      <div className="mx-auto grid max-w-6xl gap-10">
        <div className="grid max-w-3xl gap-4">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
            Docs / MCP quickstart
          </p>
          <h2 className="font-display font-bold text-4xl text-foreground tracking-tight">
            The first run ends on verify, not hope.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            The same quickstart is exposed to agents through the MCP resource
            <span className="font-mono text-foreground"> splitch://quickstart</span>. This page
            links to the live panel and remote MCP host without pretending the docs site exists yet.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-4">
          {steps.map(([title, body], index) => (
            <article className="quickstart-card" key={title}>
              <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
                Step {index + 1}
              </p>
              <h3 className="font-display font-semibold text-xl text-foreground">{title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
            </article>
          ))}
        </div>

        <div className="flex flex-wrap gap-3">
          <CtaLink href="https://mcp.splitch.dev">Open MCP host</CtaLink>
          <CtaLink href="https://app.splitch.dev" variant="secondary">
            Start in the panel
          </CtaLink>
        </div>
      </div>
    </section>
  );
}
