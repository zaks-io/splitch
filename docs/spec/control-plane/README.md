# Control-plane spec area

Spine idea: one control-plane HTTP API Worker + one auth-issuer Worker; everything else (CLI, MCP,
Tinybird, D1) derives from Zod contracts authored in `@splitch/contracts`. Invariants live in the
Worker; surfaces are thin skins.

## Files

| file | purpose |
|------|---------|
| [organization-and-membership.md](organization-and-membership.md) | Organization tier, App ownership, membership roles, D1 table shapes (`organizations`, `apps`, `org_memberships`, `app_memberships`) |
| [credentials-and-keys.md](credentials-and-keys.md) | SDK credential types (Client Key vs API Key), D1 record shapes, KV hot-validation cache, edge abuse controls, capability matrix |
| [auth-doors.md](auth-doors.md) | How a principal authenticates: the three doors (ID-JAG, anonymous/pre-claim, device flow), claim ceremony, `interaction_required` error shape, provisional demo reaping |
| [access-control-matrix.md](access-control-matrix.md) | Scopes + `app:{app_id}:{role}` format, control-plane token claims/validation, trusted-IdP D1 table, auth-issuer vs control-plane Worker split, revocation |
| [run-state-machine.md](run-state-machine.md) | Run states (`draft → running → ended`), which endpoint triggers each transition, frozen vs mutable fields, Run D1 record shape, error codes for Run invariants |
| [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md) | Thin index of the full HTTP endpoint inventory + shared conventions (error shape, pagination); links to the per-resource files below |
| [endpoints-org-app.md](endpoints-org-app.md) | Organization + member management; App CRUD — request/response shapes |
| [endpoints-flag-segment.md](endpoints-flag-segment.md) | Flag, Variant, Targeting Rule, Segment CRUD — request/response shapes |
| [endpoints-experiment-run.md](endpoints-experiment-run.md) | Experiment draft/publish lifecycle; Run reads + end — request/response shapes |
| [endpoints-metric.md](endpoints-metric.md) | Metric CRUD (binomial, count, revenue, ratio, guardrail) — request/response shapes |
| [endpoints-credentials.md](endpoints-credentials.md) | Client Key + API Key management — request/response shapes |
| [endpoints-test-eval-analytics.md](endpoints-test-eval-analytics.md) | Dry-run test-evaluation, analytics proxy reads, OpenAPI schema discovery — request/response shapes |
| [mcp-and-cli-surfaces.md](mcp-and-cli-surfaces.md) | CLI credential storage format (keychain + 0600 JSON), CLI command structure, MCP OAuth PRM + auth.md discovery chain, MCP tool naming, parity guarantee |
| [d1-and-tinybird-data-access.md](d1-and-tinybird-data-access.md) | D1 as OLTP system of record, app-enforced tenancy seam contract, KV hot-validation scope, Tinybird audit log shape and isolation |
| [zod-contract-architecture.md](zod-contract-architecture.md) | Package split (`@splitch/contracts` vs `@splitch/client`), derivation chain (Zod → types → OpenAPI → MCP schemas → hc client), error shape, PATCH-Run omit pattern |

## Key Invariants

- Assignment edits accumulate on the draft; Publish creates the single sample reset.
- Activation Metric is assignment-affecting and frozen in Run at Publish.
- First Publish opens the first Run; `draft` has no live Run.
- `live_run_id` is explicit KV state, not derived from latest D1 row.
- WorkOS is the session issuer for humans and agents; one principal, three doors.
- Auth-issuer vs control-plane Worker split: auth-issuer handles identity endpoints only;
  all CRUD (including post-create Org management) lives on the control-plane Worker
- Client Key immediately usable at creation; `origin_allowlist = null` means no origin restriction
- Tinybird never queried directly; control-plane Worker injects `app_id` from auth context

## Sources

ADRs: 0018, 0021, 0022, 0023, 0025, 0026
