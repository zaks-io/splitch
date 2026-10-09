import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { CodeSnippet } from "../components/code-snippet";
import { QuickstartRecovery } from "../components/quickstart-recovery";
import { QuickstartSteps } from "../components/quickstart-steps";
import { SPLITCH_SKILL_SOURCE } from "../docs/code-agents";
import { quickstartIntro } from "../docs/quickstart";

export const Route = createFileRoute("/quickstart")({
  head: () => ({
    meta: [
      { title: "Quickstart · splitch" },
      {
        name: "description",
        content:
          "Create a feature flag in dev and turn it on in prod with the splitch CLI and SDK. Coding agents can follow the same steps.",
      },
    ],
  }),
  component: QuickstartRoute,
});

function QuickstartRoute() {
  return (
    <main className="px-4 py-14 sm:px-6 sm:py-16">
      <div className="mx-auto grid w-full max-w-4xl gap-12">
        <header className="grid gap-4">
          <p className="flex items-center gap-2">
            <Badge variant="outline">Quickstart</Badge>
          </p>
          <h1 className="text-balance font-bold font-display text-4xl text-foreground tracking-tight sm:text-5xl">
            Zero to a resolving Flag<span className="text-arm-control">.</span>
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground leading-relaxed">
            {quickstartIntro}
          </p>
          <div className="grid max-w-2xl gap-2 rounded-lg border border-border bg-muted p-4">
            <p className="font-medium text-foreground text-sm">Building with a coding agent?</p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Install the splitch skill in your repository. Codex, Claude Code, and OpenCode can
              follow these steps with the CLI and read its JSON output.
            </p>
            <CodeSnippet code={`npx skills add ${SPLITCH_SKILL_SOURCE}`} />
            <p className="text-muted-foreground text-sm leading-relaxed">
              For an agent with native MCP support, you can also connect the remote server directly.
            </p>
            <CodeSnippet code="claude mcp add --transport http splitch https://mcp.splitch.dev" />
            <p className="text-muted-foreground text-sm leading-relaxed">
              Sign in in your browser when your agent connects. In Claude Code, run /mcp if it does
              not prompt. There is no key to copy.
            </p>
          </div>
        </header>

        <QuickstartSteps />
        <QuickstartRecovery />

        <footer className="grid gap-4 border-border border-t pt-8">
          <p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
            Your Flag is now enabled in prod. Verify never records an Exposure. SDK evaluations
            record Exposures only while an Experiment Run is live.
          </p>
          <div className="flex flex-wrap items-center gap-5">
            <Button render={<a href="/docs" />}>Read the docs</Button>
            <a
              className="font-medium text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
              href="https://app.splitch.dev"
            >
              Open the control panel
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}
