import type { ReactNode } from "react";
import { CodeSnippet } from "./code-snippet";

type Step = {
  title: string;
  body: ReactNode;
  cli?: string;
  mcp?: string;
  code?: string;
};

const steps: Step[] = [
  {
    title: "Authenticate",
    body: "Humans use the device flow. Agents connect through the MCP OAuth handshake, or bootstrap anonymously into a provisional Org that auto-deletes in 24 hours unless claimed.",
    cli: "splitch login",
    mcp: "connect https://mcp.splitch.dev\n# OAuth handshake runs on connect",
  },
  {
    title: "Pick an Organization",
    body: "Discover the Organizations your token can reach, then pick one.",
    cli: "splitch orgs list",
    mcp: "organizations_list",
  },
  {
    title: "Create an App",
    body: "A dev and a prod Environment are auto-provisioned. You do not create Environments by hand for the common case.",
    cli: 'splitch apps create --org <orgId> --name "My App"',
    mcp: 'apps_create { orgId, name: "My App" }',
  },
  {
    title: "Select the dev Environment",
    body: "Active context fills in IDs on every later call. It is convenience only and never widens authorization.",
    cli: "splitch use --app my-app --env dev",
    mcp: 'context_use { app: "my-app", environment: "dev" }',
  },
  {
    title: "Get your credential",
    body: "The Client Key is public and safe to ship in a browser. The API Key is secret, surfaced once, for trusted servers. New Client Keys start open to all origins so they work immediately; lock them to your origins before production.",
    cli: "splitch client-key get",
    mcp: "client_key_get",
  },
  {
    title: "Create a Flag",
    body: "Flag definition is App-level; serving config is per-Environment. Promote it where you want it served.",
    cli: "splitch flags create --key new-checkout --variants on,off",
    mcp: 'flags_create { key: "new-checkout", variants: ["on", "off"] }',
  },
  {
    title: "Verify",
    body: "Confirm the Flag resolves for a Targeting Key without firing an Exposure. One green round-trip proves auth, Environment, credential, and Flag config all line up. A step never ends on “probably fine.”",
    cli: "splitch flags verify new-checkout --targeting-key test-user-1",
    mcp: "flags_test_eval { flagId, evaluationContext: { targetingKey } }",
  },
  {
    title: "Wire the SDK",
    body: "evaluate() fires the first real Exposure and closes the loop. Fail-loud is one check: an error resolution names its code instead of hiding behind a default.",
    code: `import { createSplitchClient } from "@splitch/sdk";

const splitch = createSplitchClient({ clientKey: "ck_live_..." });

const d = await splitch.evaluateDetails("new-checkout", { targetingKey: userId });
if (d.reason === "ERROR") renderFallback(d.errorCode);
else render(d.value);`,
  },
];

export function QuickstartSteps() {
  return (
    <ol className="grid gap-10">
      {steps.map((step, index) => (
        <li
          className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-10"
          key={step.title}
        >
          <div className="grid content-start gap-2">
            <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
              Step {index + 1} / {steps.length}
            </p>
            <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
              {step.title}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">{step.body}</p>
          </div>
          <div className="min-w-0">
            <CodeSnippet cli={step.cli} code={step.code} mcp={step.mcp} />
          </div>
        </li>
      ))}
    </ol>
  );
}
