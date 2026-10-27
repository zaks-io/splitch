# Control-plane endpoint inventory: index

Thin index of the full HTTP endpoint inventory, split by resource group. Shared request/response
conventions live here; per-resource shapes live in the linked files.

Management CRUD endpoints live on the **Control Plane API Worker**. Auth endpoints live on the
**Auth API Worker** (see [auth-doors.md](auth-doors.md) and
[access-control-matrix.md](access-control-matrix.md)). Dry-run test-evaluation executes on the **Evaluation Worker** and analytics reads execute on the
**Analysis Worker**. Their public address is the Control Plane API Worker, which authorizes each
request and delegates over a service binding (ADR-0046). MCP uses that same Control Plane gate. All require a control-plane bearer
token unless noted. JSON requests/responses use `Content-Type: application/json`; the live-update stream
uses SSE. Wire fields follow the Zod schemas, normally camelCase; `idempotency_key` is an explicit
exception. Path placeholders below are descriptive, not a different wire naming convention.

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
  Experiments, Experiment Runs, **Promotion**, Temporary Environment **Sync**, test-eval, Experiment analytics reads, and Web
  Analytics reads.

`environment_id` accepts the canonical ID or Environment key in the path. Environment-level writes
are subject to the Environment Policy (ADR-0029).

Every Environment response includes `temporary`, either `null` for a permanent Environment or
`{ expiresAt, syncedFromEnvironmentId, syncedAt }` with ISO timestamps. Create accepts optional
`temporary: { fromEnvironmentId, expiresAt? }`; `POST …/envs/{environment_id}/sync` copies an
Environment into a Temporary Environment. See
[Environment lifecycle](endpoints-org-app.md#temporary-environment-lifecycle).

Expired Temporary Environments refuse operations whose registry `route.effects.mutates` is true,
except Environment delete, which starts teardown. HTTP method does not classify effects:
`client_key_get` provisions credentials and is fenced, while read-only POST operations remain
readable until teardown. SDK key authentication applies expiry at the public edge even for
Control Plane-owned delegated integration routes.

`POST /orgs` sits above both prefixes: the Organization does not exist yet, so there is no `org_id` to scope
against and the co-scope guard never fires. Authorization there is the handler's alone — see
[endpoints-org-app.md](endpoints-org-app.md#organization-endpoints).

## Resource groups

| file                                                                     | endpoints                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [endpoints-org-app.md](endpoints-org-app.md)                             | Organization **create** + member management; App CRUD; **Environment lifecycle and Sync**                                                   |
| [endpoints-flag-segment.md](endpoints-flag-segment.md)                   | Flag **definition** (App-level) + **Flag Configuration** (per-Env) + **Promotion** + Flag **change log**; Segment CRUD                      |
| [endpoints-experiment-run.md](endpoints-experiment-run.md)               | Experiment draft/**start** lifecycle; Experiment Run reads, standalone End, and links to Conclude (per-Env)                                 |
| [conclusion-and-winner-promotion.md](conclusion-and-winner-promotion.md) | Run conclusion, immutable decision evidence, and Approval Request based winner Promotion                                                    |
| [endpoints-metric.md](endpoints-metric.md)                               | Event Definition/version authoring + typed-field Metric CRUD (binomial, count, revenue, ratio, retention)                                   |
| [endpoints-credentials.md](endpoints-credentials.md)                     | Client Key + API Key management (per-Env)                                                                                                   |
| [endpoints-test-eval-analytics.md](endpoints-test-eval-analytics.md)     | Dry-run test-evaluation (Evaluation Worker), Experiment and Web Analytics proxy reads (Analysis Worker), OpenAPI schema discovery (per-Env) |
| [endpoints-web-analytics.md](endpoints-web-analytics.md)                 | Web Analytics overview, cursor-paginated Web Session summaries and event journeys, and Web Vitals reads (Analysis Worker, per-Env)          |
| [endpoints-privacy-data.md](endpoints-privacy-data.md)                   | Privacy requests, export jobs, delete jobs, and Entity data subject requests                                                                |

## Non-registry HTTP routes

`GET /apps/{appId}/envs/{environmentId}/live` is the authenticated Control Plane SSE connection.
`GET /privacy/requests/{requestId}/download` is the application-signed, bearer-free export capability
route. Neither derives a management tool. Health and Auth API routes are also outside the shared
registry.

## Additional registered operations

The registry in `packages/contracts/src/route-registry.ts` is the complete method, path,
operation-id, permission, effect, and error catalog. These control-plane operations supplement
those detailed in the resource files above:

| operation                         | method + path                                                                                      | contract/detail                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `principal_capabilities_get`      | `GET /principal/capabilities`                                                                      | [PAT authority](personal-access-tokens.md#request-path)             |
| `experiment_plan`                 | `POST /apps/{appId}/envs/{environmentId}/experiment-plan`                                          | [Planning](endpoints-experiment-run.md#experiment-planning)         |
| `environment_exposure_status_get` | `GET /apps/{appId}/envs/{environmentId}/exposure-status`                                           | [Exposure status](endpoints-test-eval-analytics.md#exposure-status) |
| `app_audit_list`                  | `GET /apps/{appId}/audit`                                                                          | [App audit read](d1-and-tinybird-data-access.md#app-audit-read)     |
| `cloudflare_installations_list`   | `GET /apps/{appId}/envs/{environmentId}/integrations/cloudflare/installations`                     | [Cloudflare integration](../sdk/cloudflare-worker.md)               |
| `cloudflare_installations_revoke` | `DELETE /apps/{appId}/envs/{environmentId}/integrations/cloudflare/installations/{installationId}` | `routes/routes-cloudflare.ts`                                       |
| `convex_installations_list`       | `GET /apps/{appId}/envs/{environmentId}/integrations/convex/installations`                         | [Convex integration](../sdk/convex-integration-api.md)              |
| `convex_installations_revoke`     | `DELETE /apps/{appId}/envs/{environmentId}/integrations/convex/installations/{installationId}`     | `routes/routes-convex.ts`                                           |
| `integration_deliveries_create`   | `POST /apps/{appId}/envs/{environmentId}/integrations/deliveries`                                  | [Delivery](mcp-and-cli-surfaces.md#integration-delivery)            |
| `sentry_installations_list`       | `GET /orgs/{orgId}/integrations/sentry/installations`                                              | [Sentry](../sdk/sentry-integration.md)                              |
| `sentry_installations_create`     | `POST /orgs/{orgId}/integrations/sentry/installations`                                             | `routes/routes-sentry.ts`                                           |
| `sentry_installations_get`        | `GET /orgs/{orgId}/integrations/sentry/installations/{installationId}`                             | `routes/routes-sentry.ts`                                           |
| `sentry_installations_delete`     | `DELETE /orgs/{orgId}/integrations/sentry/installations/{installationId}`                          | `routes/routes-sentry.ts`                                           |
| `sentry_secret_rotations_create`  | `POST /orgs/{orgId}/integrations/sentry/installations/{installationId}/secret-rotations`           | `routes/routes-sentry.ts`                                           |

PAT management routes are cataloged in [personal-access-tokens.md](personal-access-tokens.md#routes).
Web Analytics and decision-diagnostics routes remain intended contracts, not registered operations.
User/Organization/App privacy workflows and Organization deletion have registered placeholders;
Entity privacy workflows and request-status reads are implemented. See
[endpoints-privacy-data.md](endpoints-privacy-data.md).

## Sources

- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
