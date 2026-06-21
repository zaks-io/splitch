# MCP tool derivation: Zod → tool schemas, 1:1 parity, no hand-written schemas

Every MCP tool's `inputSchema` and `outputSchema` is derived from the Zod schemas in
`@splitch/contracts`. No tool schema is hand-written. A new endpoint becomes a new tool
mechanically. (ADR-0025, ADR-0023.)

## Naming rule

For each `@hono/zod-openapi` route registered in the control-plane contract:

```
tool name   = route.operationId
operationId = resource_operation, lower snake_case
inputSchema = route.request.body Zod schema (or query + path params for GET)
outputSchema = route.responses[200] Zod schema
errorSchema = shared ErrorResponse discriminated union (same for all tools)
```

`operationId` is explicit route metadata in `@splitch/contracts`, not inferred from the HTTP path.
That keeps tool names stable if a path changes and prevents nested routes from generating noisy
names. Adding a route without an `operationId`, or with a duplicate `operationId`, is a contract
error.

Resource naming:

- Use the glossary noun or endpoint group first: `flags`, `experiments`, `runs`, `client_key`.
- Use plural resources when callers browse collections: `flags_list`, `api_keys_create`.
- Use a singular compound resource when there is exactly one current resource per scope:
  `client_key_get`, `flag_config_update`.
- For nested resources, include enough parent context to disambiguate:
  `flag_variants_create`, `flag_targeting_rules_replace`.
- Avoid transport words in names. Use `update`, not `patch`; use domain verbs like `start`,
  `end`, `promote`, `revoke`, and `test_eval`.

Derivation runs at MCP server startup, not build time. No committed tool-definitions file.

## Tool list (canonical)

Grouped by resource. All are thin 1:1 wrappers — no per-tool invariant logic (ADR-0023).

### Organizations

| Tool                          | Method | Path                           |
| ----------------------------- | ------ | ------------------------------ |
| `organizations_get`           | GET    | `/orgs/:orgId`                 |
| `organizations_update`        | PATCH  | `/orgs/:orgId`                 |
| `organizations_delete`        | DELETE | `/orgs/:orgId`                 |
| `organization_members_list`   | GET    | `/orgs/:orgId/members`         |
| `organization_members_add`    | POST   | `/orgs/:orgId/members`         |
| `organization_members_update` | PATCH  | `/orgs/:orgId/members/:userId` |
| `organization_members_remove` | DELETE | `/orgs/:orgId/members/:userId` |

### Apps

| Tool          | Method | Path                |
| ------------- | ------ | ------------------- |
| `apps_list`   | GET    | `/orgs/:orgId/apps` |
| `apps_create` | POST   | `/orgs/:orgId/apps` |
| `apps_get`    | GET    | `/apps/:appId`      |
| `apps_update` | PATCH  | `/apps/:appId`      |
| `apps_delete` | DELETE | `/apps/:appId`      |

### Environments

| Tool                  | Method | Path                               |
| --------------------- | ------ | ---------------------------------- |
| `environments_list`   | GET    | `/apps/:appId/envs`                |
| `environments_create` | POST   | `/apps/:appId/envs`                |
| `environments_get`    | GET    | `/apps/:appId/envs/:environmentId` |
| `environments_update` | PATCH  | `/apps/:appId/envs/:environmentId` |
| `environments_delete` | DELETE | `/apps/:appId/envs/:environmentId` |

### Flags

| Tool           | Method | Path                         |
| -------------- | ------ | ---------------------------- |
| `flags_list`   | GET    | `/apps/:appId/flags`         |
| `flags_create` | POST   | `/apps/:appId/flags`         |
| `flags_get`    | GET    | `/apps/:appId/flags/:flagId` |
| `flags_update` | PATCH  | `/apps/:appId/flags/:flagId` |
| `flags_delete` | DELETE | `/apps/:appId/flags/:flagId` |

### Variants (Flag sub-resource)

| Tool                   | Method | Path                                               |
| ---------------------- | ------ | -------------------------------------------------- |
| `flag_variants_create` | POST   | `/apps/:appId/flags/:flagId/variants`              |
| `flag_variants_update` | PATCH  | `/apps/:appId/flags/:flagId/variants/:variantName` |
| `flag_variants_delete` | DELETE | `/apps/:appId/flags/:flagId/variants/:variantName` |

### Flag Configuration (per-Environment)

| Tool                           | Method | Path                                                             |
| ------------------------------ | ------ | ---------------------------------------------------------------- |
| `flag_config_get`              | GET    | `/apps/:appId/envs/:environmentId/flags/:flagId/config`          |
| `flag_config_update`           | PATCH  | `/apps/:appId/envs/:environmentId/flags/:flagId/config`          |
| `flag_targeting_rules_replace` | PUT    | `/apps/:appId/envs/:environmentId/flags/:flagId/targeting-rules` |
| `flags_promote`                | POST   | `/apps/:appId/envs/:targetEnvironmentId/flags/:flagId/promote`   |

### Targeting Rules (Flag sub-resource)

Targeting Rules are full-replaced through `flag_targeting_rules_replace`. Individual
Targeting Rule CRUD is intentionally not exposed until there is a separate endpoint contract.

### Segments

| Tool              | Method | Path                               |
| ----------------- | ------ | ---------------------------------- |
| `segments_list`   | GET    | `/apps/:appId/segments`            |
| `segments_create` | POST   | `/apps/:appId/segments`            |
| `segments_get`    | GET    | `/apps/:appId/segments/:segmentId` |
| `segments_update` | PATCH  | `/apps/:appId/segments/:segmentId` |
| `segments_delete` | DELETE | `/apps/:appId/segments/:segmentId` |

### Experiments (per-Environment, ADR-0027)

| Tool                 | Method | Path                                                               |
| -------------------- | ------ | ------------------------------------------------------------------ |
| `experiments_list`   | GET    | `/apps/:appId/envs/:environmentId/experiments`                     |
| `experiments_create` | POST   | `/apps/:appId/envs/:environmentId/experiments`                     |
| `experiments_get`    | GET    | `/apps/:appId/envs/:environmentId/experiments/:experimentId`       |
| `experiments_update` | PATCH  | `/apps/:appId/envs/:environmentId/experiments/:experimentId`       |
| `experiments_start`  | POST   | `/apps/:appId/envs/:environmentId/experiments/:experimentId/start` |
| `experiments_delete` | DELETE | `/apps/:appId/envs/:environmentId/experiments/:experimentId`       |

### Experiment Runs (Experiment sub-resource, per-Environment)

| Tool        | Method | Path                                                                     | Note                                  |
| ----------- | ------ | ------------------------------------------------------------------------ | ------------------------------------- |
| `runs_list` | GET    | `/apps/:appId/envs/:environmentId/experiments/:experimentId/runs`        | —                                     |
| `runs_get`  | GET    | `/apps/:appId/envs/:environmentId/experiments/:experimentId/runs/:runId` | —                                     |
| `runs_end`  | POST   | `/apps/:appId/envs/:environmentId/runs/:runId/end`                       | Transitions Experiment Run to `ended` |

### Metrics

| Tool             | Method | Path                             |
| ---------------- | ------ | -------------------------------- |
| `metrics_list`   | GET    | `/apps/:appId/metrics`           |
| `metrics_create` | POST   | `/apps/:appId/metrics`           |
| `metrics_get`    | GET    | `/apps/:appId/metrics/:metricId` |
| `metrics_update` | PATCH  | `/apps/:appId/metrics/:metricId` |
| `metrics_delete` | DELETE | `/apps/:appId/metrics/:metricId` |

### SDK credentials (per-Environment, ADR-0027)

| Tool                | Method | Path                                                      | Note                                 |
| ------------------- | ------ | --------------------------------------------------------- | ------------------------------------ |
| `client_key_get`    | GET    | `/apps/:appId/envs/:environmentId/client-key`             | Public value returned                |
| `client_key_update` | PATCH  | `/apps/:appId/envs/:environmentId/client-key`             | Origin/rate-limit metadata           |
| `client_key_rotate` | POST   | `/apps/:appId/envs/:environmentId/client-key/revoke`      | Revokes current key and creates next |
| `api_keys_list`     | GET    | `/apps/:appId/envs/:environmentId/api-keys`               | No secret value                      |
| `api_keys_create`   | POST   | `/apps/:appId/envs/:environmentId/api-keys`               | Secret value surfaced once           |
| `api_keys_revoke`   | POST   | `/apps/:appId/envs/:environmentId/api-keys/:keyId/revoke` | —                                    |

### Test-evaluation (dry-run)

| Tool              | Method | Path                                                       |
| ----------------- | ------ | ---------------------------------------------------------- |
| `flags_test_eval` | POST   | `/apps/:appId/envs/:environmentId/flags/:flagId/test-eval` |

Input: `TestEvaluationRequest` body. Output: `TestEvaluationResponse`.
Auth: control-plane token (not Client Key). Writes nothing; zero Exposures. (ADR-0026.)

`flags_test_eval` is the agent's verify step — the control-plane, full-reason tier. The
data-plane `POST /api/sdk/verify` (ADR-0037, Client Key / API Key) is **not** an MCP tool, for the
same reason `POST /api/sdk/evaluate` is not (see Authorization below): it is a data-plane endpoint
called by SDK clients with an SDK credential, surfaced in the CLI as `splitch flags verify` for
developers testing with the credential their code holds.

### Analytics

| Tool                     | Method | Path                                                                 |
| ------------------------ | ------ | -------------------------------------------------------------------- |
| `experiment_results_get` | GET    | `/apps/:appId/envs/:environmentId/experiments/:experimentId/results` |
| `audit_log_list`         | GET    | `/apps/:appId/audit-log`                                             |

### Privacy data

| Tool                          | Method | Path                                   |
| ----------------------------- | ------ | -------------------------------------- |
| `current_user_privacy_export` | POST   | `/users/me/privacy/export`             |
| `current_user_delete`         | DELETE | `/users/me`                            |
| `organization_privacy_export` | POST   | `/orgs/:orgId/privacy/export`          |
| `app_privacy_export`          | POST   | `/apps/:appId/privacy/export`          |
| `entity_privacy_export`       | POST   | `/apps/:appId/privacy/entities/export` |
| `entity_privacy_delete`       | POST   | `/apps/:appId/privacy/entities/delete` |
| `privacy_requests_get`        | GET    | `/privacy/requests/:requestId`         |

## Error handling in MCP tools

All tools share the same error shape — the `ErrorResponse` discriminated union from
`@splitch/contracts`. An agent narrows on `error.code` to act; each code carries typed
`details`:

- `RUN_FROZEN` → `details.frozenFields`, `details.currentRunId` (agent starts a new Experiment Run, not patch)
- `ALLOCATION_INVALID` → `details.got` (the actual sum; fix allocation to sum to 100)
- `INSUFFICIENT_SCOPES` → `details.requiredScopes` (re-authenticate with broader scopes)

No per-tool ad-hoc error shapes. (ADR-0025 "one canonical ErrorResponse".)

## Authorization

Each tool call carries the control-plane token in the transport (MCP OAuth PRM/auth.md handshake, ADR-0022).
The Worker validates the token and enforces scopes — MCP tool schemas do NOT encode auth. If auth
fails, the Worker returns `UNAUTHORIZED`; if scopes insufficient, `INSUFFICIENT_SCOPES`. The agent
never needs to know "this tool requires role X" — the Worker says so via the error code.

Data-plane evaluate (`POST /api/sdk/evaluate`) and verify (`POST /api/sdk/verify`, ADR-0037) are NOT
MCP tools — they are data-plane endpoints called directly by SDK clients using an SDK credential
(Client Key / API Key). The agent's verification path is the control-plane `flags_test_eval`.

Active-context selection (`splitch use` / MCP `context_use`) is a skin-local convenience, not a
control-plane endpoint, so it derives no tool from a Zod route — the MCP server carries active
App/Environment in the transport session (see [../control-plane/mcp-and-cli-surfaces.md](../control-plane/mcp-and-cli-surfaces.md)).

## Seam contract

**Port:** `@splitch/contracts` Zod route schemas ↔ MCP server tool registry.

- Left (contracts): `@hono/zod-openapi` route definitions with Zod request/response schemas.
- Right (MCP server): reads those schemas at startup, generates tool definitions, forwards calls via `@splitch/control-plane-sdk`.

**Failure contract:** a schema change in contracts is reflected in the tool definition on the next
server restart. Drift between "what the tool says it accepts" and "what the Worker enforces" is
impossible by construction — both consume the same Zod source.

**Deletion test:** 2 real adapters already exist (MCP server and CLI), both deriving from the same
contract package. Single-implementation boundary does not apply.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
