---
name: splitch
description: Operate and integrate Splitch feature flags and A/B experiments. Use when a project uses Splitch or a request involves Splitch Apps, Environments, Flags, Variants, Targeting Rules, Experiment Runs, Exposures, Metrics, credentials, SDK integration, or control-plane state. Prefer the Splitch CLI over browser automation.
---

# Splitch

Splitch is unified feature flags and A/B experimentation built for agents. An App owns Flags and
spans Environments. A Flag decides which Variant an Entity receives; an Experiment Run measures
the effect using Exposures and Metric Events.

## Use the CLI first

Use the `splitch` CLI for Splitch work. It exposes the same control-plane operations as the web
panel with stable JSON output, actionable errors, and command-specific help. Do not open or operate
the Control Panel when the CLI can perform the task.

The browser is expected only when `splitch login` asks the user to approve the OAuth device flow,
or when the requested task genuinely has no CLI surface.

Check the installed CLI and current scope before acting:

```bash
splitch --version
splitch context --json
```

If the CLI is unavailable, install the official package with Node.js 24 or newer:

```bash
npm install --global @splitch/cli
splitch login
```

Login may require the user to approve the printed verification URL and code. Do not work around
authentication with browser automation or an API Key.

## Scope every operation

Most commands act on an App, and many act on an Environment. Resolve scope explicitly with
`--app` and `--env`, or select it once in the repository:

```bash
splitch use --app <app-id-or-slug> --env <environment-id-or-slug> --json
splitch context --json
```

`splitch use` writes `.splitch/config.json`. Command flags take precedence over `SPLITCH_APP` and
`SPLITCH_ENV`, which take precedence over that file. Never guess an unresolved or ambiguous scope.

## Treat JSON as the agent contract

Pass `--json` on every command an agent consumes:

```bash
splitch flags list --json
splitch flags get <flag-key> --json | jq '.configurations'
```

With `--json`, stdout contains one JSON document and prose goes to stderr. Failures also return a
JSON object containing `code`, `message`, `remediation`, `docsUrl`, and `details`. Branch on the
exit status and `code`; never scrape human output or infer success from an empty value.

List responses include `readTruncated`, `readLimit`, and `cursor`. When `readTruncated` is `true`,
do not treat the response as complete. Narrow the read or inspect that command's help for a
supported continuation input; not every list command is paginable.

Use typed flags for common fields. For advanced request fields, inspect the command's generated
schema and pass the body as JSON:

```bash
splitch <resource> <action> --help
splitch <resource> <action> --body-json '<json>' --json
```

Do not invent commands, flags, request fields, or retry behavior. The installed binary's `--help`
is authoritative for its version.

## Common operations

Inspect before changing state:

```bash
splitch context --json
splitch flags list --json
splitch flags get <flag-key> --json
splitch flag-config get <flag-key> --json
splitch experiments list --json
splitch runs list <experiment-id> --json
splitch experiment-results get <experiment-id> --json
```

Create, enable, and verify a boolean Flag:

```bash
splitch flags create --key <flag-key> --variants on,off --json
splitch flag-config update <flag-key> --enabled true --rollout 100 --json
splitch flags test-eval <flag-key> --targeting-key <test-key> --json
splitch flags verify <flag-key> --targeting-key <test-key> --json
```

`flags test-eval` tests resolution through the authenticated control plane. `flags verify` makes a
real data-plane round trip with the selected Environment's Client Key. Neither fires an Exposure.
Use them for checks instead of generating fake evaluation traffic.

For a simple string equality Targeting Rule:

```bash
splitch flag-targeting-rules add <flag-key> --when <attribute>=<value> --serve <variant> --json
```

Use `flag-targeting-rules replace --body-json` for number or boolean Conditions, Segments,
non-equality operators, OR groups, reordering, or removal. Read the existing ordered rules first
because replacement sends the complete list and is last-write-wins.

Before creating or changing an Experiment, inspect the exact command help. The normal lifecycle is
`experiments create`, `experiments update`, `experiments start`, Results reads, then `runs end`.
A live Run freezes assignment inputs; do not assume a later draft edit changes that Run.

## Policies, errors, and retries

An Environment Policy may require confirmation or review. A gated mutation fails without partially
applying the change. Re-run with `--confirm` only when the response requests confirmation and the
caller authorized the mutation. `--confirm` cannot bypass a required Approval Request.

Every error includes a documentation URL. Read that URL, or append `.md` for plain Markdown, and
follow its remediation. Do not fall back to clicking through the Control Panel when a CLI command
fails.

For a retried logical mutation, reuse an explicit caller-owned `--idempotency-key`. Do not create a
new key for each retry.

## Credentials

- A Client Key (`pk_...`) is public and may be embedded in untrusted clients. Read it with
  `splitch client-key get --json`.
- An API Key (`sk_...`) is secret, server-side only, and its value is shown once at creation. Never
  print it, paste it into chat, commit it, or put it in client code.

Create an API Key directly into a new mode-`0600` file so the secret never enters terminal output:

```bash
splitch api-keys create --body-json '{"scopes":["data-plane:evaluate"]}' \
  --output-file <secret-file> --json
```

## Consumer code

When implementing Splitch in an application, inspect the live Flag and Environment with the CLI
before editing code. Reuse the application's existing Splitch client and follow the matching
official SDK guide. Preserve these data contracts:

- `evaluate` and `evaluateDetails` fire an Exposure. Call them only where the Entity encounters the
  Variant.
- Admin previews, health checks, and CI use `flags verify` or a non-exposing SDK method.
- Use the application's stable Targeting Key and reuse one caller-owned idempotency key for retries
  of the same logical Evaluation.
- Metric Events are measured facts. Emit them at the real domain-event boundary with the same Entity
  identity; never manufacture events or Exposures to populate Results.
- Keep `reason: ERROR` observable. Never silently treat a fallback value as a successful resolution.

## Documentation

Prefer the machine-readable public documentation rather than browsing the site:

- Documentation index: <https://splitch.dev/llms.txt>
- CLI guide and command reference: <https://splitch.dev/docs/cli.md>
- Quickstart: <https://splitch.dev/quickstart>
- Code-agent integration guide: <https://splitch.dev/docs/code-agents.md>
- SDK methods and Exposure behavior: <https://splitch.dev/docs/sdk/methods.md>
- Credentials: <https://splitch.dev/docs/sdk/credentials.md>
- Error catalog: <https://splitch.dev/docs/errors.md>

## Finish with evidence

After a mutation, read the resource back with `--json`. For a Flag change, also run `flags verify`
against the intended App and Environment. Report the resolved scope, changed resource IDs, and
verification result without exposing credential material.
