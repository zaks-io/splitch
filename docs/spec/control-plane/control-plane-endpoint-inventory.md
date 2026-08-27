# Control-plane endpoint inventory: index

Thin index of the full HTTP endpoint inventory, split by resource group. Shared request/response
conventions live here; per-resource shapes live in the linked files.

Management CRUD endpoints live on the **Control Plane API Worker**. Auth endpoints live on the
**Auth API Worker** (see [auth-doors.md](auth-doors.md) and
[access-control-matrix.md](access-control-matrix.md)). Dry-run test-evaluation is
control-plane-authorized but mounted on the **Evaluation Worker**. Analytics reads are
control-plane-authorized but mounted on the **Analysis Worker**. All require a control-plane bearer
token unless noted. All requests/responses are `Content-Type: application/json`.

Error shape for all endpoints: `{ code: string, message: string, details?: unknown }`.
Zod parse failures and domain-invariant failures (e.g. `RUN_FROZEN`) share this shape.

List responses: every `*_list` operation returns `ListResponse<T>` —
`{ items, readLimit, readTruncated, cursor }`. Completeness is `readTruncated`; `cursor: null` means
no continuation from this call. Canonical contract in
[../contracts/request-response-envelopes-conventions.md](../contracts/request-response-envelopes-conventions.md#listresponse-wrapper-every-_list-operation).

## App-level vs Environment-level paths (ADR-0027)

Two path prefixes, by the App/Environment split:

- **App-level** `/apps/{app_id}/…` — definition/identity shared across Environments: Org/App/member
  CRUD, Environment CRUD, **Flag definition** (key, schema, Variant catalog), Event Definitions and
  immutable published versions, Metric definitions, Segments.
- **Environment-level** `/apps/{app_id}/envs/{environment_id}/…` — live config + runtime artifacts:
  **Flag Configuration** (available Variants, targeting, rollout, enabled state), SDK credentials,
  Experiments, Experiment Runs, **Promotion**, test-eval, Experiment analytics reads, and Web
  Analytics reads.

`environment_id` is the canonical ID in the path (slugs are URL-presentation only — API paths carry
IDs). Environment-level writes are subject to the Environment Policy (ADR-0029).

`POST /orgs` sits above both prefixes: the Organization does not exist yet, so there is no `org_id` to scope
against and the co-scope guard never fires. Authorization there is the handler's alone — see
[endpoints-org-app.md](endpoints-org-app.md#organization-endpoints).

## Resource groups

| file                                                                     | endpoints                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [endpoints-org-app.md](endpoints-org-app.md)                             | Organization **create** + member management; App CRUD; **Environment CRUD**                                                                 |
| [endpoints-flag-segment.md](endpoints-flag-segment.md)                   | Flag **definition** (App-level) + **Flag Configuration** (per-Env) + **Promotion**; Segment CRUD                                            |
| [endpoints-experiment-run.md](endpoints-experiment-run.md)               | Experiment draft/**start** lifecycle; Experiment Run reads, standalone End, and links to Conclude (per-Env)                                 |
| [conclusion-and-winner-promotion.md](conclusion-and-winner-promotion.md) | Run conclusion, immutable decision evidence, and Approval Request based winner Promotion                                                    |
| [endpoints-metric.md](endpoints-metric.md)                               | Event Definition/version authoring + typed-field Metric CRUD (binomial, count, revenue, ratio)                                              |
| [endpoints-credentials.md](endpoints-credentials.md)                     | Client Key + API Key management (per-Env)                                                                                                   |
| [endpoints-test-eval-analytics.md](endpoints-test-eval-analytics.md)     | Dry-run test-evaluation (Evaluation Worker), Experiment and Web Analytics proxy reads (Analysis Worker), OpenAPI schema discovery (per-Env) |
| [endpoints-web-analytics.md](endpoints-web-analytics.md)                 | Web Analytics overview, cursor-paginated Web Session summaries and event journeys, and Web Vitals reads (Analysis Worker, per-Env)          |
| [endpoints-privacy-data.md](endpoints-privacy-data.md)                   | Privacy requests, export jobs, delete jobs, and Entity data subject requests                                                                |

## Sources

- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
