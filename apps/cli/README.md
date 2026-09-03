# @splitch/cli

The agent-first command-line interface for managing splitch Organizations, Apps, Environments,
Flags, and Experiments. Every control-plane operation the MCP server exposes is a command here, under
the same operation identity, with stable JSON output and stable exit codes for scripts and agents.

## Install

`@splitch/cli` is published on npm and requires Node.js 24 or newer.
It installs `@splitch/sdk` as its one Splitch runtime dependency.

```bash
npm install --global @splitch/cli
splitch --version
```

For a one-off run without a global install:

```bash
npx @splitch/cli --version
```

## Select a platform target

By default the CLI targets hosted splitch (`https://api.splitch.dev`, `https://auth.splitch.dev`,
`https://edge.splitch.dev`). To develop against a local splitch stack instead:

```bash
export SPLITCH_PLATFORM_TARGET=local
```

Individual origins can be overridden with `CONTROL_PLANE_API_ORIGIN`, `AUTH_API_ORIGIN`, and
`EVALUATION_API_ORIGIN`. A command fails loudly with `CLI_API_ORIGIN_MISSING` when the origin it
routes to has no default for the selected target.

There are only these three. Which origin a command uses follows the credential it presents, not
which Worker implements it: everything you authenticate for with `splitch login` goes to
`api.splitch.dev`, and only SDK-credentialled operations go to `edge.splitch.dev`.

## Authenticate and select an Environment

The CLI authenticates its control-plane session with an OAuth device flow. `splitch login` opens the
approval page in your default browser and also prints the verification URL and code for remote
terminals. A selected App is optional; App-less login is the cold-start path for creating your first
Organization and App.

```bash
export SPLITCH_APP="<app_id_or_slug>"
export SPLITCH_ENV="<environment_id_or_slug>"

splitch login
splitch use --app "$SPLITCH_APP" --env "$SPLITCH_ENV" --json
```

After browser approval, `splitch use` searches the current directory and each parent directory for
`splitch.json`. It updates the nearest file, or creates one in the current directory when none
exists. The file contains canonical scope IDs and is safe to commit:

```json
{ "version": 1, "app": "app_...", "environment": "env_..." }
```

`environment` is optional. The command reports the selected scope:

```json
{ "path": "/path/to/product/splitch.json", "app": "checkout", "environment": "dev" }
```

The CLI login is separate from the credentials used by your application at runtime:

| Credential | Use                                          | Handling                                                                                          |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Client Key | Browser, mobile, and other untrusted clients | Public; safe to ship. Fetch with `splitch client-key get`.                                        |
| API Key    | Trusted servers and edge functions           | Secret; create with `splitch api-keys create` and store the value shown once in a secret manager. |

Both credentials belong to one App and one Environment. Do not use an API Key in client-side code.
New Client Keys start open to all origins so they work immediately. Lock the Client Key to your
App's origins with `splitch client-key update` before production.

`splitch api-keys create --output-file <path>` writes the secret straight to a file at mode `0600`
instead of putting it in your terminal scrollback and your shell history. It refuses an existing path
before the key is minted, and the JSON it prints carries `valueWrittenTo` with a null `value`.

The CLI's `flags verify` command fetches the selected Environment's Client Key and uses it for a
non-exposing data-plane check; it does not use either SDK credential to log in to the control plane.

## Quickstart

Create a boolean Flag. This example uses `jq` to carry the returned Flag ID into the next command;
`--json` keeps stdout machine-readable:

```bash
FLAG_ID=$(splitch flags create \
  --key checkout \
  --variants on,off \
  --json | jq -r '.id')
```

A new Flag starts disabled with `off` as its default Variant. Enable it in the selected Environment
before evaluating:

```bash
splitch flag-config update "$FLAG_ID" --enabled true --json
```

Evaluate the Flag through the authenticated control plane. This dry run returns the full resolution
reason and does not fire an Exposure:

```bash
splitch flags test-eval checkout --targeting-key workspace-123 --id-type workspace --json
```

Verify the deployed data-plane setup by Flag KEY. The CLI fetches the selected Environment's public
Client Key for this check; verification does not fire an Exposure:

```bash
splitch flags verify checkout --targeting-key user-123 --json
```

```json
{ "value": false, "variantName": "off", "reason": "DEFAULT" }
```

The enabled Flag serves its Default Variant (`off`) until targeting rules or a rollout say
otherwise, so `false` here means the data plane is wired up correctly.

Pass `--app` and `--env` on an individual command when you do not want to persist scope. Run
`splitch context --json` to see who you are logged in as and the resolved App and Environment;
with no session it exits `2` with `CLI_NOT_AUTHENTICATED` rather than reporting empty scope.

## Working with JSON

`--json` is the contract an agent should build on. On success stdout carries the operation's response
body and nothing else; prose goes to stderr.

List commands answer one envelope, so a truncated read is visible rather than inferred:

```json
{ "items": [], "readLimit": 200, "readTruncated": false, "cursor": null }
```

`readLimit` is 200. When `readTruncated` is `true` there is more to read; pass `cursor` back to
continue. Never treat a full page as the whole set.

Typed flags cover the common fields (`--key`, `--name`, `--variants`, `--enabled`, `--rollout`,
`--targeting-key`, `--context-json`). Anything a route accepts that has no typed flag goes through
`--body-json '<json>'`; `splitch <resource> <action> --help` prints that route's body schema.

Two more worth knowing:

- `splitch flags list` and `splitch flags get <key>` return complete Flag Configurations and the
  running Experiment reference for every Environment in one request. Pass `--env prod` to limit the
  hydrated response to that Environment. Pass `--summary` for compact human columns; `--json`
  always writes the complete hydrated envelope.
- `splitch apps delete --app <app> --dry-run` lists every delete blocker with its ID and the command that
  removes it, and deletes nothing. `--force` cascades the non-gated children in dependency order and
  stops with pending Approval Request IDs where Policy requires review.

## Command map

Run `splitch --help` for the root map, `splitch <resource> --help` for a resource group, or
`splitch <resource> <action> --help` for typed flags, defaults, credential semantics, and an example.
The full generated reference, rendered from the binary's own command registry, is at
<https://splitch.dev/docs/cli>.

| Command group                 | Actions                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `login`, `logout`             | Authenticate or clear the control-plane session                               |
| `use`, `context`, `health`    | Select scope, inspect scope, or check API health                              |
| `orgs`                        | `list`, `create`, `get`, `update`                                             |
| `organization-members`        | `list`, `add`, `update`, `remove`                                             |
| `organization-usage`          | `get`                                                                         |
| `apps`                        | `list`, `create`, `get`, `update`, `delete`                                   |
| `app-members`                 | `list`, `add`, `update`, `remove`                                             |
| `app-attention-rollup`        | `get`                                                                         |
| `envs`                        | `list`, `create`, `get`, `update`, `delete`                                   |
| `env-policy`                  | `get`, `set`                                                                  |
| `environment-exposure-status` | `get`                                                                         |
| `flags`                       | `list`, `create`, `get`, `update`, `delete`, `promote`, `test-eval`, `verify` |
| `flag-variants`               | `create`, `update`, `delete`                                                  |
| `flag-config`                 | `get`, `update`                                                               |
| `flag-targeting-rules`        | `add`, `replace`                                                              |
| `segments`                    | `list`, `create`, `get`, `update`, `delete`                                   |
| `experiments`                 | `list`, `create`, `get`, `update`, `start`, `delete`                          |
| `runs`                        | `list`, `get`, `end`                                                          |
| `metrics`                     | `list`, `create`, `get`, `update`, `delete`                                   |
| `event-definitions`           | `list`, `create`, `get`, `update`                                             |
| `event-definition-versions`   | `create`, `list`, `get`                                                       |
| `experiment-results`          | `get`, `post`                                                                 |
| `client-key`                  | `get`, `update`, `rotate`                                                     |
| `api-keys`                    | `list`, `create`, `revoke`                                                    |
| `approval-requests`           | `list`, `get`                                                                 |
| `approval-request-reviews`    | `create`                                                                      |
| `cloudflare`                  | `setup`, `status`, `remove`                                                   |
| `cloudflare-installations`    | `list`, `revoke`                                                              |
| `convex-installations`        | `list`, `revoke`                                                              |
| `sentry-installations`        | `create`, `get`, `list`, `delete`                                             |
| `sentry-secret-rotations`     | `create`                                                                      |

`splitch cloudflare setup` deploys the Cloudflare integration Worker into your own Cloudflare account; see
[`@splitch/cloudflare`](https://www.npmjs.com/package/@splitch/cloudflare). The `*-installations`
groups are the operator view of integrations already installed in an Environment.

## Approval Policies

An Environment can require review before a change applies. When it does, a mutating command answers
`APPROVAL_REVIEW_REQUIRED` and names the Approval Request it opened, rather than applying the change:

```text
splitch approval-requests get <id>
```

Reruns with `--confirm` apply it if you hold approver rights. The commands that wire `--confirm` are
`experiments start`, `flag-config update`, `flag-targeting-rules replace`, `flag-variants create`,
`flag-variants update`, `flags promote`, and `segments update`. The two delete routes carry no body
and cannot honor it, so they never suggest it.

## Errors and exit codes

Every failure prints one line on stderr carrying a stable code, the cause, what to do, and a link:

```text
CLI_SCOPE_UNRESOLVED: Cause: ... Remediation: ... Docs: https://splitch.dev/docs/error/CLI_SCOPE_UNRESOLVED
```

Under `--json` that same failure also lands on stdout as one object, so a caller piping to `jq` gets
a refusal it can branch on instead of a sentence to regex:

```json
{
  "code": "CLI_SCOPE_UNRESOLVED",
  "message": "...",
  "remediation": "...",
  "docsUrl": "https://splitch.dev/docs/error/CLI_SCOPE_UNRESOLVED",
  "details": null
}
```

Scripts branch on the exit code; the printed code says which failure within that class:

| Exit | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| `0`  | Success                                                                |
| `1`  | Usage, input, or local-state failure                                   |
| `2`  | Not authenticated, session expired, or email unverified                |
| `3`  | Scope could not be resolved, or the token could not be bound to it     |
| `4`  | The API refused the request; the code is the control-plane `ErrorCode` |
| `5`  | An App or Environment matched multiple candidates; retry as listed     |

Every code the CLI, the SDK, and the API can emit has a page at
`https://splitch.dev/docs/error/{code}`, indexed at
<https://splitch.dev/docs/errors>. Append `.md` to any page for plain markdown.

## Full quickstart

Read the [public quickstart](https://splitch.dev/quickstart) for the complete path from authentication
through the first real Exposure.

- CLI reference: <https://splitch.dev/docs/cli>
- Error catalog: <https://splitch.dev/docs/errors>
- SDK guide: <https://splitch.dev/docs/sdk/install>
- Machine-readable index: <https://splitch.dev/llms.txt>
