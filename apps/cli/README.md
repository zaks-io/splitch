# @splitch/cli

The agent-first command-line interface for managing splitch Organizations, Apps, Environments,
Flags, and Experiments. It exposes the same control-plane operations as the MCP server, with stable
JSON output for scripts and agents.

## Install

`@splitch/cli` is published on npm and requires Node.js 20 or newer.

```bash
npm install --global @splitch/cli
splitch context --json
```

For a one-off run without a global install:

```bash
npx @splitch/cli context --json
```

## Authenticate and select an Environment

The CLI authenticates its control-plane session with a browser device flow. A selected App is
required for login.

```bash
export SPLITCH_APP="<app_id_or_slug>"
export SPLITCH_ENV="<environment_id_or_slug>"

splitch login --app "$SPLITCH_APP"
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

Evaluate the Flag through the authenticated control plane. This dry run returns the full resolution
reason and does not fire an Exposure:

```bash
splitch flags test-eval "$FLAG_ID" --targeting-key user-123 --json
```

Verify the deployed data-plane setup by Flag KEY. The CLI fetches the selected Environment's public
Client Key for this check; verification does not fire an Exposure:

```bash
splitch flags verify checkout --targeting-key user-123 --json
```

```json
{ "value": true, "variantName": "on", "reason": "DEFAULT" }
```

Pass `--app` and `--env` on an individual command when you do not want to persist scope. Run
`splitch context --json` to see the resolved App and Environment.

## Command map

Run `splitch --help` for the root map, `splitch <resource> --help` for a resource group, or
`splitch <resource> <action> --help` for typed flags, defaults, credential semantics, and an example.

| Command group              | Actions                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `login`, `logout`          | Authenticate or clear the control-plane session                               |
| `use`, `context`, `health` | Select scope, inspect scope, or check API health                              |
| `orgs`                     | `list`, `create`, `get`, `update`, `delete`                                   |
| `organization-members`     | `list`, `add`, `update`, `remove`                                             |
| `apps`                     | `list`, `create`, `get`, `update`, `delete`                                   |
| `envs`                     | `list`, `create`, `get`, `update`, `delete`                                   |
| `env-policy`               | `get`, `set`                                                                  |
| `flags`                    | `list`, `create`, `get`, `update`, `delete`, `promote`, `test-eval`, `verify` |
| `flag-variants`            | `create`, `update`, `delete`                                                  |
| `flag-config`              | `get`, `update`                                                               |
| `flag-targeting-rules`     | `replace`                                                                     |
| `segments`                 | `list`, `create`, `get`, `update`, `delete`                                   |
| `experiments`              | `list`, `create`, `get`, `update`, `start`, `delete`                          |
| `runs`                     | `list`, `get`, `end`                                                          |
| `metrics`                  | `list`, `create`, `get`, `update`, `delete`                                   |
| `client-key`               | `get`, `update`, `rotate`                                                     |
| `api-keys`                 | `list`, `create`, `revoke`                                                    |
| `approval-requests`        | `list`, `get`                                                                 |
| `approval-request-reviews` | `create`                                                                      |
| `app-attention-rollup`     | `get`                                                                         |
| `experiment-results`       | `get`, `post`                                                                 |
| `organization-usage`       | `get`                                                                         |
| `audit-log`                | `list`                                                                        |
| `current-user-privacy`     | `export`                                                                      |
| `current-user`             | `delete`                                                                      |
| `organization-privacy`     | `export`                                                                      |
| `app-privacy`              | `export`                                                                      |
| `entity-privacy`           | `export`, `delete`                                                            |
| `privacy-requests`         | `get`                                                                         |

## Full quickstart

Read the [public quickstart](https://splitch.dev/quickstart) for the complete path from authentication
through the first real Exposure.
