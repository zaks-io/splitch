import { CodeSnippet } from "./code-snippet";
import { SectionEyebrow } from "./section-eyebrow";

/* The MCP server is a tool the agent calls, never a page a person opens. Any
   mention of the hostname has to carry that or people paste it into a browser,
   find nothing, and leave. */
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
          <SectionEyebrow>Works inside your coding agent</SectionEyebrow>
          <h2 className="max-w-xl text-balance font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            Ask your agent for a flag<span className="text-arm-control">.</span>
          </h2>
          <p className="max-w-xl text-muted-foreground leading-relaxed">
            One command adds splitch to Claude Code, Cursor, or any MCP client. Then you ask in
            plain language and it does the setup.
          </p>

          <CodeSnippet code="claude mcp add --transport http splitch https://mcp.splitch.dev" />

          <p className="max-w-xl text-muted-foreground text-sm leading-relaxed">
            Your agent calls that endpoint and signs in on its first tool call, so there is no key
            to copy.
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
            Every panel button is also a tool here and a CLI command. Agents get the whole product,
            not a subset.
          </p>
        </div>
      </div>
    </section>
  );
}
