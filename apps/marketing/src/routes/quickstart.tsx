import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { CodeSnippet } from "../components/code-snippet";
import { QuickstartRecovery } from "../components/quickstart-recovery";
import { QuickstartSteps } from "../components/quickstart-steps";

export const Route = createFileRoute("/quickstart")({
  head: () => ({
    meta: [
      { title: "Quickstart · splitch" },
      {
        name: "description",
        content:
          "Zero to a resolving Flag with the splitch CLI. Agents get the same sequence in-band over MCP.",
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
            <Badge variant="outline">
              <span className="font-mono">splitch://quickstart</span>
            </Badge>
          </p>
          <h1 className="text-balance font-bold font-display text-4xl text-foreground tracking-tight sm:text-5xl">
            Zero to a resolving Flag<span className="text-arm-control">.</span>
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground leading-relaxed">
            This page walks the CLI path, and every step ends on a verify round-trip.
          </p>
          <div className="grid max-w-2xl gap-2 rounded-lg border border-border bg-muted p-4">
            <p className="font-medium text-foreground text-sm">Building with a coding agent?</p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Add splitch to it instead of pasting this page into its context.
            </p>
            <CodeSnippet code="claude mcp add --transport http splitch https://mcp.splitch.dev" />
            <p className="text-muted-foreground text-sm leading-relaxed">
              Your agent calls that endpoint and signs in on its first tool call, so there is no key
              to copy.
            </p>
          </div>
          <CodeSnippet
            code={`authenticate → pick an Org → create an App (dev+prod Envs auto-provisioned)
            → select the dev Environment → get a Client Key → create a Flag
            → enable + rollout → VERIFY (reason SPLIT) → wire the SDK → first real Exposure`}
          />
        </header>

        <QuickstartSteps />
        <QuickstartRecovery />

        <footer className="grid gap-4 border-border border-t pt-8">
          <p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
            Verify proves wiring; the first real evaluate proves the integration. Onboarding is done
            at the first real Exposure.
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
