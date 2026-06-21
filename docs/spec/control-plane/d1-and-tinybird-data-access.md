# D1 and Tinybird data-access: isolation seam, KV hot reads, audit log

Pins the data-access seam contract, what lives where, and how tenant isolation is enforced in each store.

## D1: relational system of record

D1 holds bounded mutable relational state. Not on the per-request hot path — hot reads served from KV.

**What lives in D1:**

| table                | purpose                                                                  |
|----------------------|--------------------------------------------------------------------------|
| `organizations`      | Org records (see [organization-and-membership.md](organization-and-membership.md))     |
| `apps`               | App records                                                              |
| `org_memberships`    | Org-level user roles                                                     |
| `app_memberships`    | App-level user roles                                                     |
| `trusted_idps`       | Trusted IdP allow-list for ID-JAG validation                             |
| `client_keys`        | Client Key records (public key material + revocation; per `(app_id, environment_id)`) |
| `api_keys`           | API Key records (hash only; secret never stored; per `(app_id, environment_id)`) |
| `environments`       | Environment records (per App; the live axis under App, ADR-0027)         |
| `flags`              | Flag **definitions** (App-level: key, schema, Variant catalog as JSON)    |
| `flag_configs`       | Flag **Configuration** per Environment (available Variants, targeting, rollout, enabled) |
| `experiments`        | Experiment records + draft assignment config (per `(app_id, environment_id)`) |
| `runs`               | Run records (frozen assignment config snapshot, status, timestamps; per `(app_id, environment_id)`) |
| `segments`           | Segment definitions (Conditions as JSON)                                 |
| `metrics`            | Metric definitions                                                       |

**What does NOT live in D1:**
- Audit events (unbounded; Tinybird)
- Exposure log (unbounded; Tinybird)
- Assignment Store (KV + Durable Object — different seam entirely)
- High-frequency usage counters (Durable Object counter, periodic D1 rollup only)

**Access layer:** Drizzle ORM, D1 driver. Same schema/migration discipline as agent-paste.
D1 rows are trusted as structurally sound (column schema + migrations enforce this); D1 rows are
not re-Zod-parsed on read. Every HTTP input crossing the Worker boundary is Zod-parsed.

## App-enforced tenancy (the isolation seam)

D1 has no row-level security. Tenant isolation is enforced in a single repository/data-access layer.

**Seam contract:**
```typescript
// Pseudo-signature — every data-access function has this shape
type Repository = {
  // every method requires app_id; it is never defaulted or optional
  getFlag(app_id: string, flag_id: string): Promise<Flag | null>
  listFlags(app_id: string, opts: PaginationOpts): Promise<Page<Flag>>
  createFlag(app_id: string, input: CreateFlagInput): Promise<Flag>
  // ... etc for all entities scoped to an App

  // Org-level methods require org_id (not app_id)
  getOrg(org_id: string): Promise<Org | null>
  listAppsForOrg(org_id: string): Promise<App[]>
}
```

**What the seam enforces:**
- Every query scopes `WHERE app_id = ?` in the SQL (never omitted)
- No raw Drizzle client is used outside this layer
- Cross-App queries do not exist; the seam has no multi-App query methods
- The seam is the designated migration boundary: if Postgres + RLS is ever required, this layer
  changes; callers are unaffected

**Failure contract:** If `app_id` is not in the auth context, the request fails at the Worker
before reaching the repository (auth middleware extracts app_id from the control-plane token scopes
and attaches it to request context). Repository methods are never called without app_id.

## KV hot-validation reads

Two read types are hot enough for KV:
1. **Session validation** — control-plane token validation (JWKS fetch is once; signature verify is CPU)
2. **SDK key validation** — per-request API Key or Client Key validation

KV schema and write-through contract: see [credentials-and-keys.md](credentials-and-keys.md).

**Everything else is NOT in KV.** Flag config and live Run ID are in KV for the data-plane evaluate
path — that is the platform seam's concern, not this one. From the control-plane perspective, D1 is
the config store and KV is the credential cache only.

Exception: `live_run:{app_id}:{environment_id}:{experiment_id}` → `run_id` is written by the
control-plane at Start time (see [run-state-machine.md](run-state-machine.md)) for the edge to read.
The key carries `environment_id` because Experiments and Experiment Runs are per-Environment (ADR-0027).
This is a one-way write; the control-plane does not read it back.

## Tinybird: audit log

Audit events for the control plane are append-only and unbounded → Tinybird, not D1.

**What is audited:** who / what / when / which door, for every control-plane mutation.

**Audit event shape (row):**
```
{
  event_id:    string     // ulid
  app_id:      string     // mandatory; first sort key
  environment_id: string | null  // co-scoped with app_id for per-Env actions (ADR-0027); null for App-level actions
  org_id:      string
  user_id:     string
  auth_door:   string     // "id_jag" | "anonymous" | "device_flow"
  action:      string     // e.g. "flag.create", "run.start", "run.end", "flag_config.promote", "api_key.revoke"
  resource_id: string     // the ID of the affected entity
  resource_type: string   // "flag" | "experiment" | "run" | "environment" | "flag_config" | ...
  detail:      string     // JSON blob; action-specific fields
  ts:          string     // ISO 8601; server-side timestamp
}
```

**Tinybird isolation:** `app_id` is a mandatory, non-defaulted parameter on every tenant-scoped pipe.
`app_id` is the first column in `ENGINE_SORTING_KEY`. A missing `app_id` fails loud; never defaults.

**Tinybird is never directly exposed to clients or agents.** Analytics reads proxy through the
Analysis Worker, which injects `app_id` and `environment_id` from control-plane auth/path context.
The Analysis Worker is the single enforcement point for Tinybird read isolation.

## Sources

- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
