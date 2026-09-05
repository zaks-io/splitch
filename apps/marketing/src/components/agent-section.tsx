import { CodeSnippet } from "./code-snippet";
import { SectionEyebrow } from "./section-eyebrow";

const canDo = [
  "Create an App, Environments, and keys",
  "Create Flags, enable them, set the rollout",
  "Verify a Flag resolves before you write code",
  "Define Metrics and start an Experiment Run",
  "Read results and end the Run",
] as const;

export function AgentSection() {
  return (
    <section className="border-border border-t bg-muted px-4 py-16 sm:px-6 sm:py-20" id="agents">
      <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <div className="grid content-start gap-5">
          <SectionEyebrow>Agent first</SectionEyebrow>
          <h2 className="max-w-xl text-balance font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            Let your agent operate splitch<span className="text-arm-control">.</span>
          </h2>
          <p className="max-w-xl text-muted-foreground leading-relaxed">
            Install the CLI, authenticate, and select your App and Environment. Your coding agent
            can then configure Flags, set up Experiments, and read results from your terminal.
          </p>

          <CodeSnippet
            code={`splitch context --json
splitch flags list --json`}
          />

          <p className="max-w-xl text-muted-foreground text-sm leading-relaxed">
            Every command supports JSON output. Errors include a code and a suggested next step, so
            your agent can act on the response. See the{" "}
            <a className="underline underline-offset-4 hover:text-foreground" href="/docs/cli">
              CLI guide
            </a>{" "}
            for setup and commands.
          </p>
        </div>

        <div className="grid content-start gap-4 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
            What it can do once connected
          </p>
          <ul className="grid gap-3">
            {canDo.map((item) => (
              <li className="flex items-start gap-3 text-foreground text-sm" key={item}>
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-2 shrink-0 rounded-sm bg-arm-treatment"
                />
                {item}
              </li>
            ))}
          </ul>
          <p className="border-border border-t pt-4 text-muted-foreground text-sm leading-relaxed">
            Prefer MCP? Connect your agent to the splitch MCP server. You can also manage Flags and
            Experiments in the control panel. Read the{" "}
            <a
              className="underline underline-offset-4 hover:text-foreground"
              href="/docs/code-agents"
            >
              agent setup guide
            </a>
            .
          </p>
        </div>
      </div>
    </section>
  );
}
