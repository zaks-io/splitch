import { CodeSnippet } from "./code-snippet";

type Step = {
  title: string;
  body: string;
  code: string;
};

const steps: Step[] = [
  {
    title: "Install and authenticate",
    body: "The CLI ships on npm and needs Node 20+. Log in with the device flow: it prints a verification URL and polls until approved.",
    code: "npm install --global @splitch/cli\nsplitch login",
  },
  {
    title: "Pick an Organization",
    body: "Discover the Organizations your token can reach, then pick one.",
    code: "splitch orgs list",
  },
  {
    title: "Create an App",
    body: "A dev and a prod Environment are auto-provisioned. You do not create Environments by hand for the common case.",
    code: 'splitch apps create --org <orgId> --name "My App"',
  },
  {
    title: "Select the dev Environment",
    body: "Active context fills in IDs on every later call. It is convenience only and never widens authorization.",
    code: "splitch use --app my-app --env dev",
  },
  {
    title: "Get your credential",
    body: "The Client Key is public and safe to ship in a browser. The API Key is secret, surfaced once, for trusted servers. New Client Keys start open to all origins so they work immediately; lock them to your origins before production.",
    code: "splitch client-key get",
  },
  {
    title: "Create a Flag",
    body: "Flag definition is App-level; serving config is per-Environment. Promote it where you want it served.",
    code: "splitch flags create --key new-checkout --variants on,off",
  },
  {
    title: "Verify",
    body: "Confirm the Flag resolves for a Targeting Key without firing an Exposure. One green round-trip proves auth, Environment, credential, and Flag config all line up. A step never ends on “probably fine.”",
    code: "splitch flags verify new-checkout --targeting-key test-user-1",
  },
  {
    title: "Wire the SDK",
    body: "evaluate() fires the first real Exposure and closes the loop. Fail-loud is one check: an error resolution names its code instead of hiding behind a default.",
    code: `import { createSplitchClient } from "@splitch/sdk";

// Paste keyMaterial from \`splitch client-key get\` (pk_…; not the ck_… keyId).
const splitch = createSplitchClient({ clientKey: "pk_..." });

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
            <p className="font-mono text-arm-control text-xs uppercase tracking-wide">
              Step {index + 1} / {steps.length}
            </p>
            <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
              {step.title}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">{step.body}</p>
          </div>
          <div className="min-w-0">
            <CodeSnippet code={step.code} />
          </div>
        </li>
      ))}
    </ol>
  );
}
