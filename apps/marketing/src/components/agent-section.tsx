import { prodSession } from "../content/agent-session";
import { CliTranscript } from "./cli-transcript";

const notes = [
  {
    term: "Prod asks first",
    body: "New Apps gate prod changes behind a confirmation. Dev applies immediately.",
  },
  {
    term: "The fix is in the error",
    body: "Each refusal carries a stable code, the next command, and a docs link, so your agent can act without guessing.",
  },
  {
    term: "Your permissions, no more",
    body: "Your agent signs in as you. The CLI and the MCP server share one typed client, so both see the same answers.",
  },
] as const;

export function AgentSection() {
  return (
    <section className="border-border border-t bg-muted px-4 py-16 sm:px-6 sm:py-24" id="agents">
      <div className="mx-auto grid w-full max-w-6xl items-start gap-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="min-w-0 lg:order-2">
          <div className="grid gap-4">
            <h2 className="text-balance font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
              Every refusal says what to do next.
            </h2>
            <p className="text-muted-foreground text-lg leading-relaxed">
              When a change is gated, your agent gets JSON with a code, the fix, and a link to the
              docs.
            </p>
          </div>

          <dl className="mt-8 grid gap-6">
            {notes.map((note) => (
              <div className="grid gap-1.5" key={note.term}>
                <dt className="font-medium text-foreground">{note.term}</dt>
                <dd className="text-muted-foreground text-sm leading-relaxed">{note.body}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-8 text-muted-foreground text-sm">
            <a className="underline underline-offset-4 hover:text-foreground" href="/docs/errors">
              Browse the error catalog
            </a>
          </p>
        </div>

        <div className="min-w-0 lg:order-1">
          <CliTranscript session={prodSession} />
        </div>
      </div>
    </section>
  );
}
