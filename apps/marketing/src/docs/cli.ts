import { cliCommandReference } from "@splitch/cli/commands";
import type { DocBlock } from "./blocks";

/**
 * Public CLI guide. Indexed from llms.txt because an agent that cannot see the
 * command surface guesses at it: the cold-start report behind SPL-452 missed
 * `--confirm` and `--json` entirely and hand-rolled retries around them.
 *
 * The reference table is derived from `@splitch/cli`'s own registry, so a
 * command documented here is a command the shipped binary answers to.
 */
function commandTable(): DocBlock {
  const scopeLabels = {
    none: "-",
    app: "App",
    environment: "Environment",
    "app+environment": "App + Environment",
  } as const;
  return {
    kind: "table",
    head: ["Command", "Scope", "--confirm", "What it does"],
    rows: cliCommandReference().map((entry) => [
      `\`${entry.command}\``,
      scopeLabels[entry.scope],
      entry.supportsConfirm ? "yes" : "no",
      entry.description,
    ]),
  };
}

export const cliDoc = {
  title: "CLI",
  summary:
    "Install, authenticate, select scope, and read every command: --json on any command, --confirm on Policy-gated changes, and stable exit codes.",
  blocks: [
    {
      kind: "prose",
      text: "The CLI is the same control plane the Control Panel drives, with one command per operation. Install it globally and authenticate once; the session is stored per machine.",
    },
    {
      kind: "code",
      lang: "bash",
      code: "npm install --global @splitch/cli\nsplitch login\nsplitch context --json",
    },
    {
      kind: "prose",
      text: "`splitch context` is the command to run first and after anything surprising: it reports the authenticated principal and the resolved App and Environment, and it fails loud rather than reporting an empty success.",
    },
    { kind: "heading", text: "Scope: App and Environment" },
    {
      kind: "prose",
      text: "Most commands operate on one App, and many on one Environment inside it. Both are resolved in the same order every time, first match wins:",
    },
    {
      kind: "list",
      items: [
        "`--app` / `--env` on the command.",
        "`SPLITCH_APP` / `SPLITCH_ENV` in the environment.",
        "`.splitch/config.json` in the current directory or an ancestor, written by `splitch use`.",
      ],
    },
    {
      kind: "code",
      lang: "bash",
      code: "splitch use --app checkout --env dev\nsplitch flags list --json",
    },
    {
      kind: "prose",
      text: "An unresolved selector is a refusal (`CLI_SCOPE_UNRESOLVED`, exit 3), never a silent pick of the only App you can see.",
    },
    { kind: "heading", text: "--json on every command" },
    {
      kind: "prose",
      text: "`--json` prints the response body as one line on stdout, with nothing else on that stream. Failures answer in the same shape, so a caller branches on a field instead of matching a sentence:",
    },
    {
      kind: "code",
      lang: "json",
      code: '{"code":"APPROVAL_REVIEW_REQUIRED","message":"...","remediation":"...","docsUrl":"https://splitch.dev/docs/error/APPROVAL_REVIEW_REQUIRED","details":{"approvalRequestId":"apr_..."}}',
    },
    {
      kind: "list",
      items: [
        "`code` is the stable identity. `message` says what happened, `remediation` says what to do next, and `docsUrl` resolves to the page for that code.",
        "`details` carries the fields you have to act on (`approvalRequestId`, `frozenFields`, `policyContexts`) and is `null` when the failure has none.",
        "The human sentence is written to stderr either way, so `--json` never costs you the readable error.",
      ],
    },
    { kind: "heading", text: "--confirm on Policy-gated changes" },
    {
      kind: "prose",
      text: "An Environment Policy can require confirmation or review before a change applies. A gated command refuses first and tells you which; it never applies half of a change. Re-run with `--confirm` when the Policy asks for confirmation:",
    },
    {
      kind: "code",
      lang: "bash",
      code: "splitch flag-config update new-checkout --enabled true --rollout 100 --confirm",
    },
    {
      kind: "prose",
      text: "When the Policy requires review instead, the refusal carries `details.approvalRequestId` and `--confirm` will not bypass it. The `--confirm` column below marks every command that parses the flag.",
    },
    { kind: "heading", text: "Secrets" },
    {
      kind: "prose",
      text: "`splitch api-keys create` returns the raw API Key under `value`, once. It is never readable again, so a run whose stdout is captured to a log has published the credential permanently. Pass `--output-file` to keep it off both streams:",
    },
    {
      kind: "code",
      lang: "bash",
      code: 'splitch api-keys create --body-json \'{"scopes":["data-plane:evaluate"]}\' --output-file ./.splitch-api-key --json',
    },
    {
      kind: "prose",
      text: "The secret lands in one new `0600` file and the payload reports `value: null` with `valueWrittenTo` naming the path. The command refuses a path that already exists, before the Key is minted. A Client Key is public and needs none of this: read it any time with `splitch client-key get`.",
    },
    { kind: "heading", text: "Exit codes" },
    {
      kind: "table",
      head: ["Code", "Meaning"],
      rows: [
        ["0", "Success."],
        ["1", "Usage, validation, or local configuration failure."],
        ["2", "Not authenticated, session expired, or email unverified."],
        ["3", "App or Environment scope unresolved, or the token refused the requested binding."],
        ["4", "The API refused the request; the `code` field names which failure."],
        ["5", "An App or Environment matched multiple candidates; retry as listed."],
      ],
    },
    { kind: "heading", text: "Command reference" },
    {
      kind: "prose",
      text: "Every command accepts `--json` and `--help`. `splitch <resource> <action> --help` prints the arguments, flags, and an example for that one command.",
    },
    commandTable(),
  ] as readonly DocBlock[],
} as const;
