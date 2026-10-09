export type TranscriptLine =
  | { readonly kind: "command"; readonly text: string }
  | { readonly kind: "output"; readonly text: string }
  | { readonly kind: "result"; readonly text: string };

export interface TranscriptSession {
  readonly label: string;
  readonly caption: string;
  readonly lines: readonly TranscriptLine[];
}

/*
 * Homepage transcripts, recorded from the published CLI (0.7.6) against the
 * real control-plane and evaluation handlers on a local fixture stack. Keep them
 * in step with the CLI, never with what reads well. Only line breaks are added:
 * long commands use shell continuations and JSON output is indented, where the
 * CLI prints one line.
 */
export const devSession: TranscriptSession = {
  label:
    "A coding agent selects the dev Environment, creates a Flag, enables it, and verifies it resolves.",
  caption: "Your agent, in the dev Environment",
  lines: [
    { kind: "command", text: "splitch use --app my-app --env dev" },
    { kind: "command", text: "splitch flags create --key new-checkout --variants on,off" },
    {
      kind: "command",
      text: `splitch flag-config update new-checkout \\
    --enabled true --rollout 100`,
    },
    {
      kind: "command",
      text: `splitch flags verify new-checkout \\
    --targeting-key test-user-1 --json`,
    },
    { kind: "result", text: '{"value":true,"variantName":"on","reason":"SPLIT"}' },
  ],
};

/*
 * The first Promotion to prod. New Apps provision prod with the `confirm` Policy
 * (control-plane-api app-create-provisioning.ts), so the Promotion returns
 * APPROVAL_REVIEW_REQUIRED and creates a pending Approval Request. Rerunning with
 * the same idempotency key and --confirm self-reviews and applies that request.
 */
const promote = `splitch flags promote new-checkout --env prod \\
    --from-environment-id env_dc3de58178eb7361e9f9319e \\
    --body-json '{"select":{"enabled":true,"rollout":true}}' \\
    --idempotency-key promote-1`;

export const prodSession: TranscriptSession = {
  label:
    "An agent promotes a Flag from dev to prod, receives a structured approval refusal that names the next command, reruns it with --confirm, and verifies the Flag resolves in prod.",
  caption: "Promoting the Flag to prod for the first time",
  lines: [
    { kind: "command", text: `${promote} --json` },
    {
      kind: "output",
      text: `{
  "code": "APPROVAL_REVIEW_REQUIRED",
  "message": "Approval Request is pending Review",
  "remediation": "Review Approval Request apr_01KWHB6FG0J93EMPZAJ0MK0MJ7 (splitch approval-requests get apr_01KWHB6FG0J93EMPZAJ0MK0MJ7), or rerun the same command with --confirm if you hold approver rights.",
  "docsUrl": "https://splitch.dev/docs/error/APPROVAL_REVIEW_REQUIRED",
  "details": {
    "approvalRequestId": "apr_01KWHB6FG0J93EMPZAJ0MK0MJ7",
    "status": "pending",
    "policyContexts": [
      {
        "environmentId": "env_21e75f3cd8224ed3a99b4868",
        "changeTypes": ["enabled_state", "targeting_rollout_value"],
        "level": "confirm"
      }
    ],
    "recommendedAction": "REVIEW_APPROVAL_REQUEST"
  },
  "outcome": "user_action_required"
}`,
    },
    { kind: "command", text: `${promote} --confirm` },
    {
      kind: "command",
      text: `splitch flags verify new-checkout --env prod \\
    --targeting-key test-user-1 --json`,
    },
    { kind: "result", text: '{"value":true,"variantName":"on","reason":"SPLIT"}' },
  ],
};
