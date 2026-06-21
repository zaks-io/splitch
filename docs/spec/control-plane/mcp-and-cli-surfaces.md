# MCP and CLI surfaces: parity skins over the shared typed client

Both surfaces are thin wrappers over the same `@splitch/client`. Capability is identical; only
presentation differs. New endpoint → new CLI command + new MCP tool, by construction.

## Package structure

```
@splitch/contracts   – Zod schemas, z.infer types, @hono/zod-openapi route defs
                       (zero transport code; safe to import from MCP, marketing site, CLI)
        ^
@splitch/client      – Hono hc<AppType> instance; type-inferred from server type; no codegen
        ^
        ├── CLI (@splitch/cli)
        └── MCP server (@splitch/mcp)
```

The split passes the deletion test: `@splitch/contracts` has 4+ real consumers (Worker, client,
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
    "access_token_expires_at": "2026-06-20T14:00:00Z"
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

**Auto-refresh on 401:** CLI exchanges refresh token or identity_assertion for a new access token
silently. Only prompts for re-login if the refresh fails (expired refresh token or revoked assertion).
On re-login for device flow, CLI outputs the verification URL and polls until approved.

### Command structure (illustrative; mirrors endpoint inventory)

```
splitch login                        # device flow; writes to credential store
splitch logout                       # revokes token; removes credential file entry
splitch orgs get <org_id>
splitch apps list --org <org_id>
splitch apps create --org <org_id> --name <name>
splitch flags list --app <app_id>
splitch flags create --app <app_id> --key <key> ...
splitch experiments create --app <app_id> ...
splitch experiments publish --app <app_id> <experiment_id>
splitch runs end <run_id>
splitch flags test-eval --app <app_id> <flag_id> --targeting-key <key> [--context-json <json>]
splitch client-key get --app <app_id>
splitch api-keys create --app <app_id>
splitch api-keys revoke --app <app_id> <key_id>
```

One command per endpoint. No composite multi-step commands in v1 unless agent ergonomics demand them.

## MCP server

**Who:** AI agents (Claude, Cursor, OpenAI Agents SDK).
**Auth:** In-band via MCP OAuth Protected Resource Metadata (PRM), with `auth.md` as the
human/agent-readable companion. Connecting triggers the handshake (401 + WWW-Authenticate
→ agent follows PRM + authorization-server metadata → control-plane token → subsequent tool
calls carry token in Authorization header). No on-disk credential; token lives in the transport
session only.
**Deployment:** Remote Worker URL (not stdio/subprocess). Zero install for agents.

### OAuth PRM + auth.md discovery chain

```
Agent connects to MCP server URL
  → 401 + WWW-Authenticate: Bearer realm="splitch" resource_metadata_url="/.well-known/oauth-protected-resource"
  → GET /.well-known/oauth-protected-resource   → { authorization_servers: [...] }
  → GET /.well-known/oauth-authorization-server  → { agent_auth: { identity_endpoint, claim_endpoint, ... } }
  → Agent picks door (ID-JAG preferred, device flow fallback)
  → POST /agent/identity → identity_assertion
  → POST /oauth2/token   → access_token
  → Subsequent tool calls: Authorization: Bearer <access_token>
```

### MCP tool schema derivation

MCP tool schemas are derived from the same Zod route definitions that validate the Worker:
- Tool `inputSchema` = Zod request body schema (converted to JSON Schema)
- Tool `outputSchema` = Zod response body schema

No hand-written tool definitions exist. A new endpoint registered in `@splitch/contracts` becomes
a new MCP tool at build/startup. An agent never hits "valid per tool schema, rejected by server"
because the schemas are byte-for-byte identical.

### Tool naming convention

`{resource}_{operation}` mapping to HTTP endpoints:
- `flags_list`, `flags_create`, `flags_get`, `flags_update`
- `experiments_create`, `experiments_publish`, `experiments_get`
- `runs_end`, `runs_get`, `runs_list`
- `flags_test_eval`
- `client_key_get`, `api_keys_create`, `api_keys_revoke`

### Parity guarantee

A capability available through the CLI must be available through an MCP tool and vice versa.
Divergence only in presentation:
- CLI: formatted text, exit codes, human-readable tables
- MCP: structured JSON, typed error responses, discriminated union reasons

## Invariants live in the Worker, not the skins

Neither CLI nor MCP contains any domain logic. Both call `@splitch/client` methods which call the
control-plane HTTP API. The Worker rejects invalid states (frozen Run edits, missing permissions,
failed Zod parse). Both surfaces inherit correctness from one guardian. (ADR-0023)

## Sources

- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
