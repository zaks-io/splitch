# Multi-tenant isolation: app_id boundary in D1, KV, and Tinybird

Tenant isolation is application-enforced at the `app_id` boundary. D1 has no row-level security.
Isolation lives in disciplined application code. This is a deliberate, recorded downgrade with an
explicit revisit condition.

## D1 isolation: Drizzle repository seam

Every D1 query routes through a single Drizzle repository layer. This seam is load-bearing for
security.

**Allowed patterns:**
- Query builder calls made through the repository interface, where `app_id` is injected as a
  mandatory WHERE clause parameter for all tenant-scoped tables
- Repository methods accept an explicit `appId: string` parameter that the implementation binds
  into every query

**Forbidden patterns:**
- Raw Drizzle client access that bypasses the repository (skipping `app_id` scoping)
- Queries that omit `app_id` on tenant-scoped tables — a query without the scope is a security bug
- Dynamic WHERE clause construction that makes `app_id` scoping conditional

**Tenant-scoped tables** (every query must carry `app_id`):
- `apps`, `flags`, `experiments`, `runs`, `api_keys`, `client_keys`, `segments`, `metrics`

**Global tables** (no per-tenant scoping; queried by identity directly):
- `organizations`, `users`, `memberships`

The repository is the designated migration boundary: if DB-enforced RLS becomes a hard requirement
(compliance, or app-level scoping judged insufficient), replacing the repository's D1 calls with
Postgres+RLS calls is a mechanical seam swap, not a cross-system refactor.

## KV isolation

KV keys are namespaced by `app_id` at the key-construction level:
- Flag config: `config:app:{appId}:flag:{flagKey}`
- Assignment Store: `assignment:{appId}:{idType}:{targetingKey}` (per-Entity read key; `appId`
  first for tenant isolation; one read returns all of the Entity's holdovers — see
  [assignment-store-substrate.md](./assignment-store-substrate.md))
- Session cache: `session:{sessionToken}` (global; carries `{ userId, appMemberships }`)
- API Key cache: `apikey:{keyHash}` (global; carries `{ appId, scopes, revoked }`)

## Tinybird isolation: two-seam enforcement

D1 isolation is enforced by the repository. Tinybird is a separate system that the repository does
not cover. Tinybird isolation therefore has its own two-seam enforcement (belt-and-suspenders, not
fallback — both are required):

**Seam 1 — mandatory non-defaulted parameter:**
Every tenant-scoped Tinybird pipe accepts `app_id` as a mandatory parameter with **no default**.
Template syntax: `{{String(app_id)}}`. A missing `app_id` must fail the pipe query, never fall
back to all tenants or a default App.

The control-plane Worker injects `app_id` from the auth context (the validated session carries
`appId`). A client or agent cannot supply an `app_id` that differs from their session scope — the
Worker validates membership before forwarding to Tinybird.

**Seam 2 — `app_id` first in `ENGINE_SORTING_KEY`:**
Every tenant-scoped Tinybird datasource has `app_id` as the first column in its
`ENGINE_SORTING_KEY`. Low-cardinality-first ordering makes per-tenant range scans physically
efficient and ensures the index structure isolates data by tenant at the storage layer.

Never use `timestamp` as the first sorting key in a multi-tenant datasource — it interleaves
tenants and makes per-tenant scans full-table scans.

**Why both are required (not one as fallback):**
- The parameter is the conceptual boundary: `app_id` is an explicit typed input that can be
  validated and logged.
- The SORTING_KEY is the physical boundary: the index structure provides query-level isolation even
  if the parameter were accidentally omitted.
- Missing either is a spec violation. Review gates must check both on any new Tinybird pipe.

## Tinybird is never queried directly by clients or agents

All Tinybird reads proxy through a control-plane Worker endpoint. The Worker injects `app_id` from
the authenticated session. This means:
- No Tinybird token is exposed to the browser, SDK, or agent
- The app_id parameter is always server-injected, never client-supplied
- The Tinybird `app_id` scope matches the control-plane auth scope by construction

## Tinybird auth and app scope

ADR-0022 tokens carry scopes like
`app:{appId}:admin`, and ADR-0018 says Tinybird isolation is parameter-enforced, not token-enforced.

The Worker applies both constraints:

1. The control-plane Worker validates the auth token and extracts `appId` from the session.
2. The Worker constructs the Tinybird query, explicitly binding `app_id = sessionAppId` as a
   mandatory parameter.
3. The Tinybird pipe enforces the parameter independently (Seam 1 above).

The auth token proves the caller has access to App X. The Worker uses that proven `appId` as the
parameter value. **Tinybird isolation is never derived from the token directly** — it is always the
Worker that bridges the two, so the isolation model is consistent: the parameter is the enforcement
point, not the auth scope. The Worker is the coordination point between the two seams.

## Revisit condition

DB-enforced RLS (Postgres+RLS) becomes a hard requirement if:
- Compliance requirements mandate DB-level isolation guarantees
- An audit finds the application-level scoping insufficient
- Multi-tenant set grows to where application discipline alone is judged inadequate

The Drizzle repository seam is the one-seam migration boundary for this change.

## Sources

- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
