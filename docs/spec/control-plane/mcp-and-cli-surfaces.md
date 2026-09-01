# MCP and CLI surfaces: parity skins over the Control Plane SDK

Both surfaces are thin wrappers over the same `@splitch/control-plane-sdk`. Capability is identical; only
presentation differs. New endpoint → new CLI command + new MCP tool, by construction.

## Package structure

```
@splitch/contracts   – Zod schemas, z.infer types, @hono/zod-openapi route defs
                       (zero transport code; safe to import from MCP, marketing site, CLI)
        ^
@splitch/control-plane-sdk      – Hono hc<AppType> transport SDK; type-inferred from server type; no codegen
        ^
        ├── CLI app (@splitch/cli)
        ├── MCP server (@splitch/mcp-server)
        └── Control Panel app (@splitch/control-panel)
```

The split passes the deletion test: `@splitch/contracts` has 4+ real consumers (Worker, SDK,
CLI, MCP, control panel). See ADR-0025.

## CLI

**Who:** humans at a terminal, scripted CI, human fallback for agents.
**Auth:** Device flow (primary) or ID-JAG (if agent invokes CLI on behalf of user).
**Invocation model:** one-shot command; returns formatted text + exit codes.

### Credential storage

Credentials stored in order of preference:

1. System keychain (macOS Keychain, Linux Secret Service)
2. `~/.splitch/credentials.json` (mode 0600, fallback for sandboxes without keychain)

**Credential file format (`~/.splitch/credentials.json`):**

```json
{
  "version": 1,
  "principal": {
    "user_id": "wos_user_...",
    "email": "user@example.com"
  },
  "credential": {
    "type": "device_flow",
    "refresh_token": "<WorkOS refresh token>",
    "access_token": "<short-lived; cached>",
    "access_token_expires_at": "2026-06-20T14:00:00Z",
    "selected_app_id": "app_..."
  }
}
```

For ID-JAG path:

```json
{
  "version": 1,
  "principal": { "user_id": "...", "email": "..." },
  "credential": {
    "type": "id_jag",
    "identity_assertion": "<splitch identity_assertion>",
    "access_token": "<short-lived; cached>",
    "access_token_expires_at": "..."
  }
}
```

**One credential per principal** (not per App). App scope is carried in the token's `scopes` claim,
not in separate credential files.

### Active context (which App / Environment to target)

Credentials are one-per-principal; **context** is the orthogonal "which App and Environment am I
operating on" selection, so `--app`/`--env` are not retyped on every command. This is a pure DX
convenience over the same endpoints — it changes which IDs the skin fills in, never authorization
(the token's scopes still gate every call).

Resolution order for `app_id` / `environment_id`, first match wins:

1. Explicit `--app` / `--env` flag on the command (always wins; the override)
2. `SPLITCH_APP` / `SPLITCH_ENV` environment variable
3. `.splitch/config.json` discovered by walking up from the cwd (nearest wins), then `~/.splitch/config.json`
4. If still unresolved and the command needs it: **fail loud** with a message naming the missing
   scope and how to set it (`splitch use ...` / `--app`), never a silent guess or a default to an
   arbitrary App.

```json
// .splitch/config.json (project-local; safe to commit — holds IDs/slugs, never credentials)
{ "version": 1, "app": "app_...", "environment": "env_..." }
```

```
splitch use --app <app_id|slug> [--env <environment_id|slug>]   # writes nearest .splitch/config.json
splitch use --env <environment_id|slug>                          # switch Environment within the current App
splitch context                                                  # print the principal plus the resolved app/env and where each came from; CLI_NOT_AUTHENTICATED (exit 2) with no session
```

`splitch use` accepts slugs (human/agent-readable) and resolves them to canonical IDs (CONTEXT.md:
slugs for URLs, IDs canonical in storage). It never stores credentials — only the target selection.

**MCP active context.** The MCP server carries the active App/Environment in the **transport
session** (alongside the token, which already lives there — line above). A `context_use` tool sets
it; subsequent tool calls inherit `app_id`/`environment_id` from the session unless the call passes
them explicitly. This is what stops an agent from re-passing full scope on every tool call. The
session context is never persisted server-side beyond the session and never widens token scope.

**Auto-refresh on 401:** CLI exchanges the refresh token or identity_assertion for a new access token
silently. Device refresh tokens rotate. Auth API retains the canonical selected App authority and
reintersects it with the WorkOS Organization grant and live membership before minting. A dead or
missing provider session fails with `CLI_SESSION_EXPIRED` (exit 2) and remediates with re-login. An
`invalid_grant` that refuses an App/Org rebind against an otherwise-live session fails with
`CLI_TOKEN_BINDING_REFUSED` (exit 3), surfaces the server's reason verbatim, and remediates with
`splitch use --app <other>` (or membership/selector repair) — never re-login. On re-login for device flow, CLI opens
`verification_uri_complete` when supplied, otherwise `verification_uri`, in the default browser,
prints the URL and code as a remote-terminal fallback, and polls until approved. A browser launch
failure is visible but does not prevent manual approval.

### Command structure (illustrative; mirrors endpoint inventory)

`--app` / `--env` below are shown for completeness; with an active context set (`splitch use`,
`SPLITCH_APP`/`SPLITCH_ENV`, or `.splitch/config.json`) they are **optional** and only needed to
override. Flags that resolve from context are marked `[ctx]`.

```
splitch login [--app <app_id|slug>]  # cold start needs no App; --app pre-binds the session to one
splitch logout                       # revokes token; removes credential file entry
splitch use --app <app|slug> [--env <env|slug>]   # set active context (writes .splitch/config.json)
splitch context                                    # show principal + resolved app/env and source
splitch orgs get <org_id>
splitch apps list --org <org_id>
splitch apps create --org <org_id> --name <name>   # provisions dev + prod Environments (DX default)
splitch envs list [--app <app_id>]                  # [ctx]
splitch envs create [--app <app_id>] --key <key> [--name <name>]  # [ctx]
splitch flags list [--app <app_id>] [--env <environment_id>] [--summary]  # scope-free reads all member Apps; [ctx] scopes
splitch flags get [--app <app_id>] [--env <environment_id>] <flag_id_or_key> [--summary]  # [ctx]
splitch flags create [--app <app_id>] --key <key> ...                       # [ctx] App-level definition
splitch flags promote [--app <app_id>] [--env <environment_id>] <flag_id>   # [ctx] move Flag Configuration into an Env (ADR-0028)
splitch event-definitions list [--app <app_id>]                              # [ctx] App-level
splitch event-definitions create [--app <app_id>] --body-json '{"name":"checkout","family":"metric","displayName":"Checkout"}' # [ctx]
splitch event-definition-versions create [--app <app_id>] <event_definition_id> --body-json '{"entityType":"user","fields":[],"dimensions":[]}' # [ctx] immutable publish
splitch metrics list [--app <app_id>]                                        # [ctx]
splitch metrics create [--app <app_id>] --body-json '{"name":"Conversion","key":"conversion","kind":"binomial","eventDefinitionId":"<id>"}' # [ctx]
splitch env-policy get [--app <app_id>] [--env <environment_id>]            # [ctx]
splitch env-policy set [--app <app_id>] [--env <environment_id>] ...        # [ctx] per-change-type confirm gates (ADR-0029)
splitch experiments create [--app <app_id>] [--env <environment_id>] ...    # [ctx]
splitch experiments start [--app <app_id>] [--env <environment_id>] <experiment_id>  # [ctx]
splitch runs end [--app <app_id>] [--env <environment_id>] <run_id>         # [ctx]
splitch flags test-eval [--app <app_id>] [--env <environment_id>] <flag_key> --targeting-key <key> [--context-json <json>]  # [ctx] control-plane, full reason
splitch flags verify [--app <app_id>] [--env <environment_id>] <flag_key> --targeting-key <key> [--context-json <json>]     # [ctx] setup confirmation (ADR-0037)
splitch client-key get [--app <app_id>] [--env <environment_id>]            # [ctx]
splitch api-keys create [--app <app_id>] [--env <environment_id>]           # [ctx]
splitch api-keys revoke [--app <app_id>] [--env <environment_id>] <key_id>  # [ctx]
```

One command per endpoint. CLI/MCP author and discover Event Definitions and Metrics and manage Flags,
Environments, Experiments, policies, evaluations, and credentials, but they do not impersonate an SDK
producer for Metric Event or Web Event ingestion: the SDK's `track()` and `web.track()` data-plane
calls are not control-plane CLI/MCP commands. No composite multi-step commands unless agent
ergonomics demand them.
Experiments, Experiment Runs, and SDK credentials are per-Environment (ADR-0027), so their commands
need an Environment (from `[ctx]` or `--env`); Flag definition, Environment CRUD, and policy reads
are App/Env scoped accordingly. Environment-level writes that the Environment Policy gates may
require a `--confirm` affordance (ADR-0029); it submits the canonical
`review.action = "approve_and_apply"` and never creates a separate confirmation pipeline.

With no resolved App, `splitch flags list` makes one `principal_flags_list` request and returns every
Flag visible through the principal's live Organization and App memberships. Human output groups rows
by the `org.slug/app.key` selector and includes the canonical App ID. The route hydrates complete
per-Environment Configurations across those Apps by default; `--summary` selects compact human
output and does not request hydration. The MCP `principal_flags_list` tool accepts an `envs`
Environment selector list, subject to `FLAG_READ_ENVIRONMENT_SELECTOR_LIMIT`. Environment keys are
unique within an App, so a key selector hydrates the Environment it names in every readable App; a
canonical ID selector hydrates only its owning App, and Flags in the other Apps carry no
Configuration for it. A selector that names no readable Environment anywhere returns
`ENVIRONMENT_NOT_FOUND` rather than an empty hydration. If the bounded result is incomplete, the CLI
says to narrow it with `--app`.

With `--app`, `SPLITCH_APP`, active App config, or an explicit `--env`, the command uses the scoped
`flags_list` route; `--env` therefore requires an App.

`splitch flags list` and `splitch flags get` send `include=config` by default, returning each Flag's
complete per-Environment Configurations and running Experiment reference in the same request. An
explicit `--env` is sent verbatim as an `envs` selector and resolved by the server; when `--env` is
absent the CLI omits `envs`, so the server hydrates every Environment in the App. Active
`SPLITCH_ENV` or config context does not silently narrow an App-level read. `--summary` selects
compact human columns and does not request hydration. `flags list --summary --env` uses the
one-Environment `environmentId` summary; `flags get --summary` has no Environment selector.

`--json` envelopes are verb-class consistent: a get returns the resource bare, and the matching
write returns those same fields at the same paths with `approvalRequest` alongside (never wrapped
in `config` or `flag`). List commands — including `flags list`, `api-keys list`, and
`approval-requests list` — return `{items, readLimit, readTruncated, cursor}` so a caller can tell a
complete page from a truncated one.

**Output and scripting:** every command accepts `--json` for machine-readable output (the same
shape the MCP tool returns), so the CLI is pipe-able and an agent shelling out to the CLI parses one
contract. Flag reads preserve the complete hydrated envelope under `--json`; their default human
output uses the established aligned-column and labeled-section patterns without truncating values.
When a required scope is unresolved, the CLI fails loud with the exact `splitch use` / `--app`
remedy, never a silent default.

## MCP server

**Who:** AI agents (Claude, Cursor, OpenAI Agents SDK).
**Auth:** In-band via MCP OAuth Protected Resource Metadata (PRM), with `auth.md` as the
human/agent-readable companion. Connecting triggers the handshake (401 + WWW-Authenticate
→ agent follows PRM + AuthKit authorization-server metadata → authorization code with S256 PKCE →
exact MCP-resource token → subsequent tool calls carry that token in the Authorization header).
The MCP Worker validates the AuthKit signature, exact issuer and audience, expiry, not-before time,
and subject before JSON-RPC dispatch. No on-disk credential; the client token lives only in the
transport session and is never forwarded downstream.
**Deployment:** Remote Worker URL (not stdio/subprocess). Zero install for agents.

### OAuth PRM + auth.md discovery chain

```
Agent connects to MCP server URL
  → 401 + WWW-Authenticate: Bearer realm="splitch", resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource{/mcp}"
  → GET ${mcpOrigin}/.well-known/oauth-protected-resource{/mcp}   → { resource, authorization_servers }
  → GET ${authkitIssuer}/.well-known/oauth-authorization-server
  → Agent supplies a Client ID Metadata Document or dynamically registers a public client
  → Agent starts AuthKit authorization code flow with resource=<exact MCP resource> and S256 PKCE
  → Human signs in and consents through WorkOS/AuthKit
  → Agent exchanges the one-use code with the same client, redirect URI, and PKCE verifier
  → AuthKit issues the exact-resource access token and owns refresh and revocation
  → Subsequent tool calls: Authorization: Bearer <authkit_access_token>
```

For each tool call, MCP creates a separate short-lived delegated credential bound to the derived
operation, the public surface that operation is addressed at, verified actor, method, exact
downstream path/query, and body digest. An AuthKit actor carries an empty-scope signed
`liveMembership` marker rather than membership rows or scopes. Every management operation is addressed at the Control
Plane, because a route's public address follows its credential rather than its owner (ADR-0046); the
Control Plane validates the delegation signature, operation, surface, method, target, body,
freshness, and one-use replay identifier before resolving the actor's current Organization and App
memberships from D1. It then runs the unchanged route scope and tenant co-scope gates and delegates
onward to Analysis or Evaluation when the registered route says so. Legacy Splitch-issued MCP
tokens continue to carry their already-verified bounded scopes in the same one-call credential.
Only named Worker service-binding entrypoints accept the delegation. Public Worker entrypoints do
not, and downstream requests never contain the client bearer. Replay identifiers are claimed
atomically through a Durable Object; missing secrets, replay bindings, membership access, and
storage errors fail closed before downstream route dispatch.

The Splitch Auth API's anonymous and first-party CLI device doors remain separate from browser MCP
OAuth. Dynamically registered AuthKit clients cannot use the first-party device door.

### MCP tool schema derivation

MCP tool schemas are derived from the same Zod route definitions that validate the Worker:

- Tool `inputSchema` = Zod request body schema (converted to JSON Schema)
- Tool `outputSchema` = Zod response body schema

No hand-written tool definitions exist. Public agent operations registered in `@splitch/contracts`
become MCP tools at build/startup. Explicit internal operations, including MCP-to-Control-Plane
binding plumbing, are excluded from tool discovery.

The execution schema remains byte-for-byte identical to the Worker schema. The protocol schema may
make an App or Environment selector optional when MCP session context can fill that selector before
execution. After context resolution, the unchanged execution schema validates the complete input,
so the server never executes a request that the Worker schema rejects.

### Tool naming convention

The MCP tool name is the route `operationId` from `@splitch/contracts`. It uses
`resource_operation` lower snake_case, e.g. `flags_list`, `flags_update`, `flags_promote`,
`experiments_start`, `runs_end`, `flags_test_eval`, `client_key_get`, and `api_keys_revoke`.

The canonical naming rule and complete tool list live in
[../contracts/mcp-tool-derivation.md](../contracts/mcp-tool-derivation.md). This file must not carry
a second tool-name table. Experiment, Run, credential, and test-eval tools take `app_id` +
`environment_id` inputs (per-Env, ADR-0027); the schemas are derived from the per-Env route
definitions, so parity with the CLI holds by construction.

### Discovery layer (prompts + resources)

The derived tools are the capability surface; they do not tell an agent where to start or what the
nouns mean. MCP **prompts** (guided workflows like `onboard_new_app`) and **resources** (the
glossary, auth model, the agent's active context and scopes) sit over the tools and make splitch
self-onboarding without the docs site. Like `context_use`, these are MCP-protocol capabilities, not
endpoint skins. The full design is in [mcp-discovery.md](./mcp-discovery.md).

### Parity guarantee

A capability available through the CLI must be available through an MCP tool and vice versa.
Divergence only in presentation:

- CLI: labeled sections for hydrated Flag reads, aligned columns under `--summary`, compact JSON
  with `--json`, indented JSON for other human output, and exit codes
- MCP: structured JSON, typed error responses, discriminated union reasons

## Invariants live in the Worker, not the skins

Neither CLI nor MCP contains any domain logic. The CLI calls those methods through the published
`@splitch/sdk/control-plane` package interface; MCP imports the private authoring package
`@splitch/control-plane-sdk` directly. Both reach the same control-plane HTTP API. The Worker
rejects invalid states (frozen Run edits, missing permissions, failed Zod parse). Both surfaces
inherit correctness from one guardian. (ADR-0023 and ADR-0025's 2026-08-26 amendment)

## Sources

- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
