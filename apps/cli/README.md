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
The CLI's `flags verify` command fetches the selected Environment's Client Key and uses it for a
non-exposing data-plane check; it does not use either SDK credential to log in to the control plane.

## Quickstart

List the Flags in the selected App. Use `--json` for machine-readable output:

```bash
splitch flags list --json
```

```json
{
  "items": [
    {
      "id": "flag_checkout",
      "appId": "app_local",
      "key": "checkout",
      "name": "Checkout",
      "schema": null,
      "variants": [{ "id": "var_on", "name": "on", "value": true }],
      "defaultVariantId": "var_on",
      "createdAt": "2026-07-03T00:00:00.000Z",
      "updatedAt": "2026-07-03T00:00:00.000Z"
    }
  ],
  "readTruncated": false,
  "readLimit": 200
}
```

Verify one Flag for a Targeting Key without firing an Exposure:

```bash
splitch flags verify flag_checkout --targeting-key user-123 --json
```

```json
{ "value": true, "variantName": "on", "reason": "DEFAULT" }
```

Pass `--app` and `--env` on an individual command when you do not want to persist scope. Run
`splitch context --json` to see the resolved App and Environment.

## Full quickstart

See [`docs/spec/quickstart.md`](../../docs/spec/quickstart.md) for the complete path from
authentication through the first real Exposure.
