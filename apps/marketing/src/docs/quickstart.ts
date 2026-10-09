export type QuickstartStep = {
  title: string;
  body: string;
  code: string;
};

export const quickstartIntro =
  "Install the CLI, create a Flag, and verify it before connecting your app to the SDK.";

export const quickstartSteps: readonly QuickstartStep[] = [
  {
    title: "Install and authenticate",
    body: "The CLI ships on npm. Log in with the device flow: it prints a verification URL and polls until approved.",
    code: "npm install --global @splitch/cli\nsplitch login",
  },
  {
    title: "Pick an Organization",
    body: "Discover the Organizations your token can reach, then pick one.",
    code: "splitch orgs list",
  },
  {
    title: "Create an App",
    body: "Creating an App also creates its dev and prod Environments.",
    code: 'splitch apps create --org <orgId> --name "My App"',
  },
  {
    title: "Select the dev Environment",
    body: "Select the App and Environment to use for the following commands. This selection does not change your permissions.",
    code: "splitch use --app my-app --env dev",
  },
  {
    title: "Get your credential",
    body: "The Client Key is public and safe to ship in a browser. The API Key is secret, surfaced once, for trusted servers. New Client Keys start open to all origins so they work immediately; lock them to your origins before production.",
    code: "splitch client-key get",
  },
  {
    title: "Create a Flag",
    body: "Define the Flag once for the App, then configure it for each Environment. A new Flag starts disabled and serves the Default Variant until you enable it and set a Percentage Rollout.",
    code: "splitch flags create --key new-checkout --variants on,off --lifecycle-class release --owner checkout-team --expires-at 2027-01-01T00:00:00Z",
  },
  {
    title: "Enable and roll out",
    body: "Enable the Flag and set its Percentage Rollout to 100% so every Targeting Key in this Environment gets the non-default Variant. See /docs/flags for Flag Configuration fields.",
    code: "splitch flag-config update new-checkout --enabled true --rollout 100",
  },
  {
    title: "Verify",
    body: 'Verify the Flag for a Targeting Key without recording an Exposure. If the response has reason "DISABLED", enable the Flag before continuing. After enabling it, expect reason "SPLIT" and value true. This confirms that your credentials and Flag Configuration work in the selected Environment.',
    code: `splitch flags verify new-checkout --targeting-key test-user-1 --json
# before enable: {"value":false,"variantName":"off","reason":"DISABLED"}
# after enable:  {"value":true,"variantName":"on","reason":"SPLIT"}`,
  },
  {
    title: "Wire the SDK",
    body: 'Evaluate the Flag in your app to record its first Exposure. Check for reason "ERROR" and use errorCode to handle a failed evaluation.',
    code: `import { createSplitchClient } from "@splitch/sdk";

// Paste keyMaterial from \`splitch client-key get\` (pk_…; not the ck_… keyId).
const splitch = createSplitchClient({ clientKey: "pk_..." });

const d = await splitch.evaluateDetails("new-checkout", {
  targetingKey: userId,
});
if (d.reason === "ERROR") renderFallback(d.errorCode);
else render(d.value);`,
  },
];

export const quickstartRecoveries = [
  [
    "APPROVAL_REVIEW_REQUIRED",
    "the Environment Policy gates this change",
    "review the durable request",
  ],
  [
    "VARIANT_NOT_AVAILABLE",
    "the Variant is not promoted to this Environment",
    "promote the Variant to this Environment, then retry",
  ],
  [
    "RUN_FROZEN",
    "the edit touches a running Experiment Run",
    "clone into a new draft Experiment Run",
  ],
  [
    "APP_MISMATCH",
    "wrong key for this App or Environment",
    "fetch the credential for this Environment",
  ],
  [
    "401 / 403",
    "bad or revoked key, or origin not allowed",
    "check the key and its origin allow-list",
  ],
] as const;
