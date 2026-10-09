export type TranscriptLine =
  | { readonly kind: "command"; readonly text: string }
  | { readonly kind: "output"; readonly text: string }
  | { readonly kind: "result"; readonly text: string };

export interface TranscriptSession {
  readonly label: string;
  readonly caption: string;
  readonly lines: readonly TranscriptLine[];
}

/**
 * Homepage transcripts. Keep them in step with the CLI, never with what reads
 * well: commands follow the published quickstart (docs/quickstart.ts) and each
 * output is the shape its source produces.
 */
export const devSession: TranscriptSession = {
  label:
    "A coding agent selects the dev Environment, creates a Flag, enables it, and verifies it resolves.",
  caption: "Your agent, in the dev Environment",
  lines: [
    { kind: "command", text: "splitch use --app my-app --env dev" },
    {
      kind: "command",
      text: `splitch flags create --key new-checkout \\
    --variants on,off --lifecycle-class release \\
    --owner checkout-team \\
    --expires-at 2027-01-01T00:00:00Z`,
    },
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
 * The first prod rollout. New Apps provision prod with the `confirm` Policy
 * (control-plane-api app-create-provisioning.ts), so the change is refused with
 * the server's APPROVAL_REVIEW_REQUIRED body (approval-review-outcomes.ts). The
 * CLI's --json error shape is CliErrorJson in cli/src/errors.ts, and remediation
 * comes from approvalReviewRequiredRemediation in cli/src/approval-stale-warn.ts.
 * The CLI prints one line and wraps nothing; it is formatted here for reading.
 */
const approvalRequestId = "apr_01K7Q3M9VZ8T2D4XBN6HCRW5EJ";

export const prodSession: TranscriptSession = {
  label:
    "An agent turns a Flag on in prod, receives a structured approval refusal that names the next command, and reruns it with --confirm, then verifies the Flag resolves in prod.",
  caption: "Turning the Flag on in prod for the first time",
  lines: [
    {
      kind: "command",
      text: `splitch flag-config update new-checkout --env prod \\
    --enabled true --rollout 100 --json`,
    },
    {
      kind: "output",
      text: `{
  "code": "APPROVAL_REVIEW_REQUIRED",
  "message": "Approval Request is pending Review",
  "remediation": "Review Approval Request ${approvalRequestId} (splitch approval-requests get ${approvalRequestId}), or rerun the same command with --confirm if you hold approver rights.",
  "docsUrl": "https://splitch.dev/docs/error/APPROVAL_REVIEW_REQUIRED",
  "details": {
    "approvalRequestId": "${approvalRequestId}",
    "status": "pending",
    "policyContexts": [
      {
        "environmentId": "env_01K7Q2ZC4T6WJ8M0A3RYNX9PDH",
        "changeTypes": ["enabled_state", "targeting_rollout_value"],
        "level": "confirm"
      }
    ],
    "recommendedAction": "REVIEW_APPROVAL_REQUEST"
  },
  "outcome": "user_action_required"
}`,
    },
    {
      kind: "command",
      text: `splitch flag-config update new-checkout --env prod \\
    --enabled true --rollout 100 --confirm`,
    },
    {
      kind: "command",
      text: `splitch flags verify new-checkout --env prod \\
    --targeting-key test-user-1 --json`,
    },
    { kind: "result", text: '{"value":true,"variantName":"on","reason":"SPLIT"}' },
  ],
};
