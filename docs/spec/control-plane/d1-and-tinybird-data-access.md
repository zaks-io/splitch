# D1 and Tinybird data-access: isolation seam, KV hot reads, audit log

Pins the data-access seam contract, what lives where, and how tenant isolation is enforced in each store.

## D1: relational system of record

D1 holds bounded mutable relational state. Not on the per-request hot path — hot reads served from KV.

**What lives in D1:**

| table                       | purpose                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `organizations`             | Org records (see [organization-and-membership.md](organization-and-membership.md))                  |
| `apps`                      | App records                                                                                         |
| `org_memberships`           | Org-level user roles                                                                                |
| `app_memberships`           | App-level user roles                                                                                |
| `privacy_requests`          | Bounded privacy request ledger (IDs/hashes only; no raw Targeting Keys)                             |
| `entity_deletions`          | Entity deletion tombstones for immediate analysis exclusion                                         |
| `trusted_idps`              | Trusted IdP allow-list for ID-JAG validation                                                        |
| `client_keys`               | Client Key records (public key material + revocation; per `(app_id, environment_id)`)               |
| `api_keys`                  | API Key records (hash only; secret never stored; per `(app_id, environment_id)`)                    |
| `environments`              | Environment records (per App; the live axis under App, ADR-0027)                                    |
| `flags`                     | Flag **definitions** (App-level: key, schema, Variant catalog as JSON)                              |
| `flag_configs`              | Flag **Configuration** per Environment (available Variants, targeting, rollout, enabled)            |
| `experiments`               | Experiment records + draft assignment config (per `(app_id, environment_id)`)                       |
| `runs`                      | Run records (frozen assignment config snapshot, status, timestamps; per `(app_id, environment_id)`) |
| `segments`                  | Segment definitions (Conditions as JSON)                                                            |
| `event_definitions`         | App-level Event Definition identity and current published version pointer                           |
| `event_definition_versions` | Immutable published Event Definition schemas shared across Environments                             |
| `metrics`                   | Metric definitions referencing Event Definitions and named typed fields                             |
| `convex_installations`      | Environment-scoped callback and encrypted webhook-secret metadata                                   |
| `config_webhook_deliveries` | Durable config-change nudges inserted atomically with the owning config commit                      |

**What does NOT live in D1:**

- Audit events (unbounded; Tinybird)
- Exposure log (unbounded; Tinybird)
- Metric Event log (unbounded; Tinybird)
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
  getFlag(app_id: string, flag_id: string): Promise<Flag | null>;
  listFlags(app_id: string, opts: PaginationOpts): Promise<Page<Flag>>;
  createFlag(app_id: string, input: CreateFlagInput): Promise<Flag>;
  // ... etc for all entities scoped to an App

  // Org-level methods require org_id (not app_id)
  getOrg(org_id: string): Promise<Org | null>;
  listAppsForOrg(org_id: string): Promise<App[]>;
};
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

App-scoped control-plane audit facts are committed to the D1
`control_plane_audit_events` outbox in the **same batch** as each mutation, then forwarded to
Tinybird `audit_log`. D1 is the bounded delivery bridge; Tinybird is the append-only security
record. Flag-domain history remains in `flag_change_events` and is neither copied nor merged into
this list. Organization, principal and authentication-door events are a later slice.

### Commit and delivery contract

Each immutable outbox fact contains `seq`, unique UUID `event_id`, `app_id`, nullable
`environment_id`, server-derived `organization_id`, `actor_ref`, `actor_via`, route `operationId`
as `action`, `resource_type`, `resource_id`, nullable `target_version`, `outcome`, request,
Approval Request and Run correlation ids, allowlisted `changes_json`, and server `changed_at`.
Only `forwarded_at` changes during delivery. There are no attribution triggers or subject foreign
keys. The actor comes from the resolved principal; unknown references or doors remain null and
project explicitly as `unattributed`. A known `deleted-user:<reference>` tombstone is preserved;
reads do not infer deletion from missing membership or fetch names/emails.

The post-commit `waitUntil` and every-minute cron share the Control Plane sender in
`approval-archive-tinybird.ts`. Each batch contains at most 50 rows, uses `dedup_key = event_id`
and `wait=true`, and requires HTTP 200, exact `successful_rows`, and zero quarantined rows before
acknowledgment. A failed append or lost response leaves the batch pending. Physical duplicates
are expected under at-least-once delivery. The daily cron removes only forwarded rows older than
90 days, in bounded batches. Failed deliveries remain eligible regardless of age.

Ordinary rows use `audit_id = event_id`; `changes` is canonical JSON containing
`environmentId`, `organizationId`, `targetVersion`, `outcome`, `requestId`, `approvalRequestId`,
`runId` and `metadata`. Named optional metadata fields are `changedFields`, `reviewId`,
`reviewAction`, `resultingTargetVersion`, `errorCode`, `role`, `previousRole` and `revokedKeyId`.
Credential material and hashes, bearer tokens, Targeting Keys, Evaluation Context values,
raw diffs, reasons and error details are never copied. Field names are recorded instead of values.

### App audit read

`app_audit_list` is `GET /apps/:appId/audit`. Control Plane calls `requireAppAdmin` against live
App membership and credential scope before any downstream request. An Organization role alone
confers no access. A deleted App has no audit read visibility.

The Analysis Worker is the sole Tinybird ordinary-event read boundary and injects the authorized
`app_id`. The `app_audit_events` pipe refuses a missing App. It excludes Approval archives,
groups ordinary rows by `audit_id`, verifies equal canonical content for every physical duplicate,
and deduplicates **before** applying filters or pagination. Any conflicting identity fails loudly,
including when the requested filters would hide it. Pages order by timestamp and event id descending;
the cursor binds the App and filters. Responses use the shared `ListResponse` bounds and cursor.
The typed SDK exposes `apps.listAudit`; CLI and MCP use the same registered operation and schemas.

Filters: `environmentId`, `action`, `resourceType`, `resourceId`, `approvalRequestId`, `runId`,
`from`, `to`, `limit`, `cursor`. Callers cannot supply Tinybird tenant parameters. Tinybird tokens
are never exposed to callers or agents.

### Producer coverage and retry semantics

Every row below includes the common fact fields above. A recognized replay or a refused/no-write
attempt emits nothing. A committed Approval Request and a committed Review are separate facts;
a failed application that commits a failed Review still records that Review. A conclusion commits
both the Run decision and its generated Approval Request in one batch and records both facts.

| Action group / action                                                         | Atomic producer                                                                                                           | Additional fields                                                                                     | Existing retry identity or no-write recognition                                       | Known gaps                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Credentials: `api_keys_create`                                                | `credentials.createApiKey`                                                                                                | Environment, new key id                                                                               | **none**; two committed calls mint two keys and two events                            | Once-only secret responses are unchanged; no credential replay is added                                                         |
| Credentials: `api_keys_revoke`                                                | `credentials.revokeApiKey`                                                                                                | Environment, key id                                                                                   | Key id plus already-revoked state                                                     | No separate idempotency-key store                                                                                               |
| Credentials: `client_key_update`                                              | `credentials.updateClientKey`                                                                                             | Environment, key id, changed field names                                                              | Current-state equality; unchanged patch is a no-write                                 | Origin and rate-limit values are deliberately omitted                                                                           |
| Credentials: `client_key_rotate`                                              | `credentials.rotateClientKey`                                                                                             | Environment, replacement and revoked key ids                                                          | **none**; every committed call rotates again                                          | No recovery/replay of returned key material                                                                                     |
| App membership: `app_members_add`, `app_members_update`, `app_members_remove` | `identity-app-memberships` guarded batches                                                                                | Subject user id, new role where applicable                                                            | Existing membership, role equality, missing membership and last-owner guards          | Organization membership remains outside this slice                                                                              |
| Promotion: `flags_promote`                                                    | `flag-config-ops` batch, through Config Store                                                                             | Target Environment, actual Configuration id and committed version, selected field names               | Existing gate replay identity; empty selection writes nothing                         | Ungated Promotion has no durable retry identity; committed repeats retain existing behavior                                     |
| Run Start: `experiments_start`                                                | `experiment-start-run` guarded batch                                                                                      | Run id, frozen config hash, Environment and Approval id when gated                                    | Existing frozen draft/live Run preconditions and Approval replay                      | A fresh accepted Start retains existing new-Run behavior                                                                        |
| Run End: `runs_end`                                                           | `experiment-end-run` guarded batch                                                                                        | Run id, frozen config hash, Environment                                                               | Running/live Run state guard                                                          | End reason is deliberately omitted                                                                                              |
| Run Conclusion: `runs_conclude`                                               | `experiment-conclusion-atomic` guarded batch                                                                              | Run id, config hash, generated Approval id and target version                                         | Actor plus conclusion idempotency key and request hash                                | Selected Variant, raw results and reason are deliberately omitted                                                               |
| Indirect Approval Request creation                                            | `approvals.createRequest`; conclusion and replacement batches                                                             | Original route action, Request id, target version, pending outcome and Environment                    | Actor plus idempotency key and request hash; replacement ordinal/target preconditions | Original proposal diffs are never copied; definition-only history remains in Flag change log                                    |
| Review: `approval_request_reviews_create`                                     | `approval-atomic`, explicit guarded variant/config/deletion batches, raw Run Start batch, disposition and failure batches | Request and Review ids, Review action/outcome, resulting target version, Run correlation, error code  | Request plus reviewer plus idempotency key and request hash                           | Applied Promotion is correlated by its Review and resulting version; no second Flag history store                               |
| Actor projection                                                              | `app_audit_list`, matching the Approval archive projection                                                                | Opaque `userRef`: live WorkOS reference, carried `deleted-user:*` tombstone, or explicit unattributed | Read-only projection; no actor rewrite                                                | User-account deletion does not yet rewrite or map audit actor references. When that lifecycle lands, it must supply the mapping |

`audit_log` has no TTL and retains records for at least 24 months or the contracted audit period,
whichever is longer. App deletion removes read visibility; audit/security retention does not make
these records product analytics. The existing Flag log retains its separate 90-day age-plus-cursor
policy. This slice preserves tombstones carried by canonical rows and never resolves actors to
names or emails. Historical actor backfill, user-account deletion integration, SIEM export and
Organization/principal audit reads are outside this slice. See the
[privacy lifecycle contracts](../platform/privacy-data-lifecycle.md).

## Sources

- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
