# Control-plane endpoint inventory: index

Thin index of the full HTTP endpoint inventory, split by resource group. Shared request/response
conventions live here; per-resource shapes live in the linked files.

All endpoints live on the **control-plane Worker** (except auth endpoints on the auth-issuer Worker,
see [auth-doors.md](auth-doors.md) and [access-control-matrix.md](access-control-matrix.md)). All
require a control-plane bearer token unless noted. All requests/responses are `Content-Type: application/json`.

Error shape for all endpoints: `{ code: string, message: string, details?: unknown }`.
Zod parse failures and domain-invariant failures (e.g. `RUN_FROZEN`) share this shape.

Pagination: `?limit=50&offset=0` on all list endpoints. Response includes `{ items: T[], total: number, limit: number, offset: number }`.

## Resource groups

| file | endpoints |
|------|-----------|
| [endpoints-org-app.md](endpoints-org-app.md) | Organization + member management; App CRUD |
| [endpoints-flag-segment.md](endpoints-flag-segment.md) | Flag, Variant, Targeting Rule, Segment CRUD |
| [endpoints-experiment-run.md](endpoints-experiment-run.md) | Experiment draft/publish lifecycle; Run reads + end |
| [endpoints-metric.md](endpoints-metric.md) | Metric CRUD (binomial, count, revenue, ratio, guardrail) |
| [endpoints-credentials.md](endpoints-credentials.md) | Client Key + API Key management |
| [endpoints-test-eval-analytics.md](endpoints-test-eval-analytics.md) | Dry-run test-evaluation, analytics proxy reads, OpenAPI schema discovery |

## Sources

- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
