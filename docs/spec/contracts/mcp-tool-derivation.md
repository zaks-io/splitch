# MCP tool derivation: Zod → tool schemas, 1:1 parity, no hand-written schemas

Every MCP tool's `inputSchema` and `outputSchema` is derived from the Zod schemas in
`@splitch/contracts`. No tool schema is hand-written. A new endpoint becomes a new tool
mechanically. (ADR-0025, ADR-0023.)

## Derivation rule

For each `@hono/zod-openapi` route registered in the control-plane contract:

```
tool name   = snake_case(HTTP method + path segments)
              e.g. POST /api/flags → create_flag; PATCH /api/flags/:id → patch_flag
inputSchema  = route.request.body Zod schema (or query + path params for GET)
outputSchema = route.responses[200] Zod schema
errorSchema  = shared ErrorResponse discriminated union (same for all tools)
```

Derivation runs at MCP server startup, not build time. No committed tool-definitions file.

## Tool list (canonical)

Grouped by resource. All are thin 1:1 wrappers — no per-tool invariant logic (ADR-0023).

### Organizations

| Tool                  | Method | Path                     |
| --------------------- | ------ | ------------------------ |
| `create_organization` | POST   | `/api/organizations`     |
| `get_organization`    | GET    | `/api/organizations/:id` |
| `patch_organization`  | PATCH  | `/api/organizations/:id` |

### Apps

| Tool         | Method | Path            |
| ------------ | ------ | --------------- |
| `create_app` | POST   | `/api/apps`     |
| `list_apps`  | GET    | `/api/apps`     |
| `get_app`    | GET    | `/api/apps/:id` |
| `patch_app`  | PATCH  | `/api/apps/:id` |
| `delete_app` | DELETE | `/api/apps/:id` |

### Flags

| Tool          | Method | Path             |
| ------------- | ------ | ---------------- |
| `create_flag` | POST   | `/api/flags`     |
| `list_flags`  | GET    | `/api/flags`     |
| `get_flag`    | GET    | `/api/flags/:id` |
| `patch_flag`  | PATCH  | `/api/flags/:id` |
| `delete_flag` | DELETE | `/api/flags/:id` |

### Variants (Flag sub-resource)

| Tool             | Method | Path                              |
| ---------------- | ------ | --------------------------------- |
| `create_variant` | POST   | `/api/flags/:flagId/variants`     |
| `patch_variant`  | PATCH  | `/api/flags/:flagId/variants/:id` |
| `delete_variant` | DELETE | `/api/flags/:flagId/variants/:id` |

### Targeting Rules (Flag sub-resource)

| Tool                    | Method | Path                                     |
| ----------------------- | ------ | ---------------------------------------- |
| `create_targeting_rule` | POST   | `/api/flags/:flagId/targeting-rules`     |
| `patch_targeting_rule`  | PATCH  | `/api/flags/:flagId/targeting-rules/:id` |
| `delete_targeting_rule` | DELETE | `/api/flags/:flagId/targeting-rules/:id` |

### Segments

| Tool             | Method | Path                |
| ---------------- | ------ | ------------------- |
| `create_segment` | POST   | `/api/segments`     |
| `list_segments`  | GET    | `/api/segments`     |
| `get_segment`    | GET    | `/api/segments/:id` |
| `patch_segment`  | PATCH  | `/api/segments/:id` |
| `delete_segment` | DELETE | `/api/segments/:id` |

### Experiments (per-Environment, ADR-0027)

| Tool                | Method | Path                                                   |
| ------------------- | ------ | ------------------------------------------------------ |
| `create_experiment` | POST   | `/api/apps/:appId/envs/:environmentId/experiments`     |
| `list_experiments`  | GET    | `/api/apps/:appId/envs/:environmentId/experiments`     |
| `get_experiment`    | GET    | `/api/apps/:appId/envs/:environmentId/experiments/:id` |
| `patch_experiment`  | PATCH  | `/api/apps/:appId/envs/:environmentId/experiments/:id` |

### Experiment Runs (Experiment sub-resource, per-Environment)

| Tool               | Method | Path                                                                   | Note                                                |
| ------------------ | ------ | ---------------------------------------------------------------------- | --------------------------------------------------- |
| `start_experiment` | POST   | `/api/apps/:appId/envs/:environmentId/experiments/:id/start`           | Ends running Experiment Run, opens new one          |
| `list_runs`        | GET    | `/api/apps/:appId/envs/:environmentId/experiments/:id/runs`            | —                                                   |
| `get_run`          | GET    | `/api/apps/:appId/envs/:environmentId/experiments/:id/runs/:runId`     | —                                                   |
| `patch_run`        | PATCH  | `/api/apps/:appId/envs/:environmentId/experiments/:id/runs/:runId`     | Non-material only; assignment fields → `RUN_FROZEN` |
| `end_run`          | POST   | `/api/apps/:appId/envs/:environmentId/experiments/:id/runs/:runId/end` | Transitions Experiment Run to `ended`               |

### Metrics

| Tool            | Method | Path               |
| --------------- | ------ | ------------------ |
| `create_metric` | POST   | `/api/metrics`     |
| `list_metrics`  | GET    | `/api/metrics`     |
| `get_metric`    | GET    | `/api/metrics/:id` |
| `patch_metric`  | PATCH  | `/api/metrics/:id` |
| `delete_metric` | DELETE | `/api/metrics/:id` |

### SDK credentials (per-Environment, ADR-0027)

| Tool                | Method | Path                                                              | Note                                  |
| ------------------- | ------ | ----------------------------------------------------------------- | ------------------------------------- |
| `create_api_key`    | POST   | `/api/apps/:appId/envs/:environmentId/api-keys`                   | Value surfaced once in response       |
| `list_api_keys`     | GET    | `/api/apps/:appId/envs/:environmentId/api-keys`                   | No value field                        |
| `revoke_api_key`    | POST   | `/api/apps/:appId/envs/:environmentId/api-keys/:credId/revoke`    | —                                     |
| `create_client_key` | POST   | `/api/apps/:appId/envs/:environmentId/client-keys`                | Value surfaced once; freely shareable |
| `list_client_keys`  | GET    | `/api/apps/:appId/envs/:environmentId/client-keys`                | —                                     |
| `revoke_client_key` | POST   | `/api/apps/:appId/envs/:environmentId/client-keys/:credId/revoke` | —                                     |

### Test-evaluation (dry-run)

| Tool            | Method | Path                                |
| --------------- | ------ | ----------------------------------- |
| `test_evaluate` | GET    | `/api/flags/:flagKey/test-evaluate` |

Input: `{ flagKey, targetingKey, idType, attributes? }` (query params). Output:
`TestEvaluationResponse { variant, reason }`. Auth: control-plane
token (not Client Key). Writes nothing; zero Exposures. (ADR-0026.)

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

Data-plane evaluate (`POST /api/sdk/evaluate`) is NOT an MCP tool — it is a public endpoint called
directly by SDK clients using a Client Key.

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
