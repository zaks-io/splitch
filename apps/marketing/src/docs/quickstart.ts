export type QuickstartStep = {
  title: string;
  body: string;
  code: string;
};

export const quickstartIntro =
  "Install the CLI, create and verify a Flag in dev, connect the SDK, then turn the Flag on in prod.";

export const quickstartSteps: readonly QuickstartStep[] = [
  {
    title: "Install and authenticate",
    body: "The CLI ships on npm. Log in with the device flow: it prints a verification URL and polls until approved.",
    code: "npm install --global @splitch/cli\nsplitch login",
  },
  {
    title: "Choose or create an Organization",
    body: "List the Organizations you can access. If the list is empty, create one. Use the Organization's returned id as --org in the next step.",
    code: `splitch orgs list --json
# If the list is empty:
splitch orgs create --name "My Org" --json`,
  },
  {
    title: "Create an App",
    body: "Replace <orgId> with your Organization's id. Creating an App also creates dev and prod Environments. Save the id of the entry with key dev in the returned environments array. You will need that canonical env_ ID to Promote to prod.",
    code: 'splitch apps create --org <orgId> --name "My App" --json',
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
    body: "Define the Flag once for the App, then configure it for each Environment. The CLI defaults the lifecycle class to release, the owner to you, and expiry to 90 days. A new Flag starts disabled and serves the Default Variant until you enable it and set a Percentage Rollout.",
    code: "splitch flags create --key new-checkout --variants on,off",
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
    title: "Install the SDK",
    body: "Install the JavaScript SDK in your app.",
    code: "npm install @splitch/sdk",
  },
  {
    title: "Wire the SDK",
    body: 'Replace pk_... with the dev keyMaterial from client-key get, then run this example in a JavaScript module. It evaluates the Flag for test-user-1 and logs the result. Check for reason "ERROR" and use errorCode to handle a failed evaluation. SDK evaluations record Exposures only while an Experiment Run is live. This plain Flag has no Experiment Run, so it records no Exposure.',
    code: `import { createSplitchClient } from "@splitch/sdk";

// Paste keyMaterial from \`splitch client-key get\` (pk_…; not the ck_… keyId).
const splitch = createSplitchClient({ clientKey: "pk_..." });

const d = await splitch.evaluateDetails("new-checkout", {
  targetingKey: "test-user-1",
});
if (d.reason === "ERROR") throw new Error(d.errorCode);
console.log(d.value, d.variantName, d.reason);`,
  },
  {
    title: "Promote to prod",
    body: "Promote the enabled state and Percentage Rollout from dev to prod. Replace <devEnvironmentId> with the id of the dev entry in environments[] from App creation. --from-environment-id requires the canonical env_ ID, while --env accepts the key prod. New Apps use the confirm Policy for these prod changes. This command returns APPROVAL_REVIEW_REQUIRED with exit code 4 and a pending Approval Request. Prod stays unchanged until Confirmation.",
    code: `splitch flags promote new-checkout --env prod --from-environment-id <devEnvironmentId> --body-json '{"select":{"enabled":true,"rollout":true}}' --idempotency-key promote-1 --json`,
  },
  {
    title: "Review and confirm the Promotion",
    body: "Inspect the Approval Request using details.approvalRequestId from the previous response. When you are ready to apply it, rerun the same Promotion command with the same idempotency key and add --confirm. Under the confirm Policy, this Confirmation lets you self-review and apply the pending Approval Request.",
    code: `splitch approval-requests get <approvalRequestId> --json
splitch flags promote new-checkout --env prod --from-environment-id <devEnvironmentId> --body-json '{"select":{"enabled":true,"rollout":true}}' --idempotency-key promote-1 --json --confirm`,
  },
  {
    title: "Verify prod and connect your app",
    body: "Verify the Flag in prod, then fetch prod's Client Key. Replace the SDK example's clientKey with the returned keyMaterial to connect your production app. Each Environment has its own credential. Restrict the Client Key to your production origins before shipping it.",
    code: `splitch flags verify new-checkout --env prod --targeting-key test-user-1 --json
# {"value":true,"variantName":"on","reason":"SPLIT"}
splitch client-key get --env prod --json`,
  },
];

export const quickstartRecoveries = [
  [
    "APPROVAL_REVIEW_REQUIRED",
    "the Environment Policy gates this change",
    "inspect the Approval Request, then provide Confirmation if you intend to apply it",
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
