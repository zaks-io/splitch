# @splitch/cli

The agent-first command-line interface for managing splitch Organizations, Apps, Environments,
Flags, and Experiments. It exposes the same control-plane operations as the MCP server, with stable
JSON output for scripts and agents.

## Install

`@splitch/cli` is published on npm and requires Node.js 20 or newer.

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

After browser approval, `splitch use` writes the nearest `.splitch/config.json` and reports the
selected scope:

```json
{ "path": "/path/to/product/.splitch/config.json", "app": "checkout", "environment": "dev" }
```

The CLI login is separate from the credentials used by your application at runtime:

| Credential | Use                                          | Handling                                                                                          |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Client Key | Browser, mobile, and other untrusted clients | Public; safe to ship. Fetch with `splitch client-key get`.                                        |
| API Key    | Trusted servers and edge functions           | Secret; create with `splitch api-keys create` and store the value shown once in a secret manager. |

Both credentials belong to one App and one Environment. Do not use an API Key in client-side code.
New Client Keys start open to all origins so they work immediately. Lock the Client Key to your
App's origins before production.
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
splitch flags test-eval checkout --targeting-key user-123 --json
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

## Command map

Run `splitch --help` for the root map, `splitch <resource> --help` for a resource group, or
`splitch <resource> <action> --help` for typed flags, defaults, credential semantics, and an example.

| Command group                 | Actions                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `login`, `logout`             | Authenticate or clear the control-plane session                               |
| `use`, `context`, `health`    | Select scope, inspect scope, or check API health                              |
| `orgs`                        | `list`, `create`, `get`, `update`                                             |
| `organization-members`        | `list`, `add`, `update`, `remove`                                             |
| `apps`                        | `list`, `create`, `get`, `update`, `delete`                                   |
| `app-members`                 | `list`, `add`, `update`, `remove`                                             |
| `envs`                        | `list`, `create`, `get`, `update`, `delete`                                   |
| `env-policy`                  | `get`, `set`                                                                  |
| `environment-exposure-status` | `get`                                                                         |
| `event-definitions`           | `list`, `create`, `get`, `update`                                             |
| `event-definition-versions`   | `create`, `list`, `get`                                                       |
| `flags`                       | `list`, `create`, `get`, `update`, `delete`, `promote`, `test-eval`, `verify` |
| `flag-variants`               | `create`, `update`, `delete`                                                  |
| `flag-config`                 | `get`, `update`                                                               |
| `flag-targeting-rules`        | `replace`                                                                     |
| `segments`                    | `list`, `create`, `get`, `update`, `delete`                                   |
| `experiments`                 | `list`, `create`, `get`, `update`, `start`, `delete`                          |
| `runs`                        | `list`, `get`, `end`                                                          |
| `metrics`                     | `list`, `create`, `get`, `update`, `delete`                                   |
| `client-key`                  | `get`, `update`, `rotate`                                                     |
| `api-keys`                    | `list`, `create`, `revoke`                                                    |
| `approval-requests`           | `list`, `get`                                                                 |
| `approval-request-reviews`    | `create`                                                                      |
| `app-attention-rollup`        | `get`                                                                         |
| `experiment-results`          | `get`, `post`                                                                 |
| `organization-usage`          | `get`                                                                         |

## Errors and exit codes

Every failure prints one line carrying a stable code, the cause, what to do, and a link:

```text
CLI_SCOPE_UNRESOLVED: Cause: ... Remediation: ... Docs: https://splitch.dev/docs/error/CLI_SCOPE_UNRESOLVED
```

Scripts branch on the exit code; the printed code says which failure within that class:

| Exit | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| `0`  | Success                                                                |
| `1`  | Usage, input, or local-state failure                                   |
| `2`  | Not authenticated, session expired, or email unverified                |
| `3`  | Scope could not be resolved, or the token could not be bound to it     |
| `4`  | The API refused the request; the code is the control-plane `ErrorCode` |

Every code the CLI, the SDK, and the API can emit has a page at
`https://splitch.dev/docs/error/{code}`, indexed at
<https://splitch.dev/docs#errors>. Append `.md` to any page for plain markdown.

## Full quickstart

Read the [public quickstart](https://splitch.dev/quickstart) for the complete path from authentication
through the first real Exposure.

- Error catalog: <https://splitch.dev/docs#errors>
- SDK guide: <https://splitch.dev/docs/sdk/install>
- Machine-readable index: <https://splitch.dev/llms.txt>
