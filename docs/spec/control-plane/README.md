# Control-plane spec area

Spine idea: the Control Plane API Worker owns authenticated management mutations, the Auth API
Worker owns identity/token issuance, and MCP, Evaluation, Event Ingest, and Analysis remain separate
capability Workers. Shared contracts come from `@splitch/contracts`; skins stay thin.

## Files

| file                                                                       | purpose                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [organization-and-membership.md](organization-and-membership.md)           | Organization tier, App ownership, membership roles, D1 table shapes (`organizations`, `apps`, `org_memberships`, `app_memberships`)                                                                                               |
| [credentials-and-keys.md](credentials-and-keys.md)                         | SDK credential types (Client Key vs API Key), D1 record shapes, KV hot-validation cache, edge abuse controls, capability matrix                                                                                                   |
| [auth-doors.md](auth-doors.md)                                             | How a principal authenticates: the three identity doors (ID-JAG, anonymous/pre-claim, device flow), shared-preview `client_credentials` smoke grant, claim ceremony, `interaction_required` error shape, provisional demo reaping |
| [access-control-matrix.md](access-control-matrix.md)                       | Scopes + `app:{app_id}:{role}` format, control-plane token claims/validation, trusted-IdP D1 table, Worker responsibility split, revocation                                                                                       |
| [run-state-machine.md](run-state-machine.md)                               | Run states (`draft → running → ended`), which endpoint triggers each transition, frozen vs mutable fields, Run D1 record shape, error codes for Run invariants                                                                    |
| [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md) | Thin index of the full HTTP endpoint inventory + shared conventions (error shape, pagination); links to the per-resource files below                                                                                              |
| [endpoints-org-app.md](endpoints-org-app.md)                               | Organization + member management; App CRUD; **Environment CRUD** — request/response shapes                                                                                                                                        |
| [endpoints-flag-segment.md](endpoints-flag-segment.md)                     | Flag definition (App-level), Flag Configuration + **Promotion** (per-Env), Variant, Targeting Rule, Segment CRUD — request/response shapes                                                                                        |
| [endpoints-experiment-run.md](endpoints-experiment-run.md)                 | Experiment draft/start lifecycle; Run reads + end (per-Env) — request/response shapes                                                                                                                                             |
| [endpoints-metric.md](endpoints-metric.md)                                 | Metric CRUD (binomial, count, revenue, ratio, guardrail) — request/response shapes                                                                                                                                                |
| [endpoints-credentials.md](endpoints-credentials.md)                       | Client Key + API Key management (per-Env) — request/response shapes                                                                                                                                                               |
| [endpoints-test-eval-analytics.md](endpoints-test-eval-analytics.md)       | Dry-run test-evaluation, analytics proxy reads, OpenAPI schema discovery — request/response shapes                                                                                                                                |
| [mcp-and-cli-surfaces.md](mcp-and-cli-surfaces.md)                         | CLI credential storage format (keychain + 0600 JSON), CLI command structure, MCP OAuth PRM + auth.md discovery chain, MCP tool naming, parity guarantee                                                                           |
| [mcp-discovery.md](mcp-discovery.md)                                       | MCP prompts (guided workflows) + resources (glossary, auth, active context, capabilities) over the derived tools; the error → recovery prompt loop; onboarding discovery handshake                                                |
| [endpoints-privacy-data.md](endpoints-privacy-data.md)                     | Privacy request, export, deletion, and Entity data subject request endpoints                                                                                                                                                      |
| [d1-and-tinybird-data-access.md](d1-and-tinybird-data-access.md)           | D1 as OLTP system of record, app-enforced tenancy seam contract, KV hot-validation scope, Tinybird audit log shape and isolation                                                                                                  |
| [zod-contract-architecture.md](zod-contract-architecture.md)               | Package split (`@splitch/contracts` vs `@splitch/control-plane-sdk`), derivation chain (Zod → types → OpenAPI → MCP schemas → hc client), error shape, PATCH-Run omit pattern                                                     |

## Key Invariants

- Environment is a first-class axis under App (ADR-0027): Experiments, Experiment Runs, Exposures,
  and SDK credentials are per-Environment; Flag definition is App-level, Flag Configuration is per-Env.
- The Environment-level surface adds three operations: **Start** (Experiment Run), **Promote** (Flag
  Configuration across Environments, ADR-0028), and **Confirm** (the Environment Policy gate, ADR-0029).
- Assignment edits accumulate on the draft; Start creates the single sample reset.
- Activation Metric is assignment-affecting and frozen in Run at Start.
- First Start opens the first Run; `draft` has no live Run.
- `live_run_id` is explicit KV state (key `live_run:{app_id}:{environment_id}:{experiment_id}`), not
  derived from latest D1 row.
- WorkOS is the session issuer for humans and agents; one principal, three identity doors. The
  shared-preview `client_credentials` grant is smoke-only and resolves to a seeded WorkOS user.
- Auth API vs Control Plane API split: Auth API handles identity endpoints only;
  management CRUD, including post-create Org management, lives on the Control Plane API Worker.
- Client Key immediately usable at creation; `origin_allowlist = null` means no origin restriction
- Tinybird never queried directly; Analysis Worker injects `app_id` and `environment_id` from
  control-plane auth/path context.
- Privacy requests are first-class Control Plane API operations. Delete jobs commit tombstones before
  async physical purge.

## Sources

ADRs: 0018, 0021, 0022, 0023, 0025, 0026, 0027, 0028, 0029
