# Backup and disaster recovery

Status: designed, not wired. As of 2026-09-08 nothing in this repository backs up production data.
The only recovery primitives are the ones Cloudflare provides by default (D1 Time Travel and Durable
Object point-in-time recovery, both 30 days, both in place) and
[deployment-pipeline.md](./deployment-pipeline.md) explicitly scopes those as incident procedures,
not routine rollback. This document records what exists, what is unrecoverable today, the target
recovery objectives, and the work to close the gap.

Vocabulary follows [CONTEXT.md](../../../CONTEXT.md). Store assignments follow
[storage-map.md](./storage-map.md); do not move data between stores here.

## What exists today

| Store                           | Built-in recovery                                               | Off-store copy | Restore procedure written           |
| ------------------------------- | --------------------------------------------------------------- | -------------- | ----------------------------------- |
| D1 `splitch-production-d1`      | Time Travel, 30 days, minute granularity, restores in place     | none           | no                                  |
| SQLite Durable Objects          | PITR, 30 days, per object, only callable from inside the object | none           | no                                  |
| Legacy KV Durable Object (MCP)  | none                                                            | none           | n/a (session state)                 |
| Workers KV (5 namespaces)       | none                                                            | none           | partial (credential cache backfill) |
| Tinybird `splitch_prod`         | vendor daily backup, kept 2 days, restore by support request    | none           | no                                  |
| R2 `splitch-privacy-exports`    | none (no versioning)                                            | none           | n/a (regenerable)                   |
| Cloudflare Queues + DLQs        | none                                                            | none           | n/a (in-flight)                     |
| Worker secrets / GitHub secrets | write-only; neither can be read back                            | none           | no                                  |
| WorkOS, Stripe                  | vendor-managed                                                  | none           | no                                  |

D1 Time Travel cannot fork or clone, and it cannot recover a deleted database. Durable Object PITR
restores one object at a time and only from code running inside that object, so it is not a fleet
recovery tool. Both are useless if the Cloudflare account itself is lost or compromised.

Tinybird's own backup is not a customer tool. The
[security page](https://www.tinybird.co/security) states that databases are backed up daily,
retained for two days, tested annually, and "in a recovery scenario, data is restored to the most
recent daily backup". That is a whole-workspace rollback opened through support, not a per-datasource
or point-in-time restore, and a mistake noticed on day three is unrecoverable. The `splitch_prod`
workspace is on the Enterprise plan (verified with `tb workspace ls` on 2026-09-08), which unlocks
Sink pipes, Copy pipes, and Branches at the limits used below. The production deploy script
(`scripts/deploy-tinybird-production.mjs`) runs `tb deploy --check` then `tb deploy --wait` without
`--allow-destructive-operations`, so a deploy cannot drop a datasource or its history by default.
Keep that flag out of the script; a deliberately destructive deploy is preceded by an on-demand
sink run.

## Data classes and what losing each one means

Ordered by blast radius. Tier 0 is unrecoverable by any means once lost.

### Tier 0: the App identity atom and the secrets that wrap it

- `app_entity_identity_key` (one per App) is the HMAC key behind every `targeting_key_hash` in
  Tinybird, every Assignment Store key, and every privacy tombstone
  ([privacy-data-lifecycle.md](./privacy-data-lifecycle.md), "Rules"). The wrapped record lives in
  the per-App Config Store Durable Object (`apps/control-plane-api/src/config-store-app-identity.ts`)
  with a replica in the `CONFIG_STORE` KV namespace under `app:{appId}:entity-identity`
  (`packages/contracts/src/storage-keys-kv.ts`).
- It is wrapped under `EVALUATION_PRIVACY_SALT`. That secret, plus `INTEGRATION_SECRET_KEK`,
  `CONVEX_WEBHOOK_KEK`, `EXPOSURE_TICKET_KEY`, `ACCESS_TOKEN_SECRET`, `ASSERTION_SIGNING_SECRET`,
  and `PRIVACY_EXPORT_URL_SECRET`, exists only as a GitHub environment secret and a Worker secret.
  Neither store can return the value. An accidental overwrite through
  `scripts/sync-worker-secrets.mjs` is indistinguishable from deletion.
- Losing either half for an App is equivalent to the destructive App-wide privacy reset: every
  Exposure, Assignment, Metric Event, and tombstone for that App becomes unjoinable to new traffic.
  Losing the root secret does that for every App at once.

### Tier 1: D1, the relational system of record

35 tables, about 1.6 MB, region WNAM, read replication disabled. Organizations, Apps, memberships,
Environments, Flags, Flag Configurations, Experiments, Runs, Segments, Metrics, Event Definitions,
credentials (hashes), privacy request ledger, Entity deletion tombstones, integration installations,
the flag change log. Everything the KV projections are rebuilt from.

### Tier 2: Tinybird datasources that are the only copy

Production holds very little today. Sizes from `tinybird.datasources_storage` on 2026-09-08:

| Datasource                                                                                 | Rows  | Size    |
| ------------------------------------------------------------------------------------------ | ----- | ------- |
| `raw_evaluations`                                                                          | 1,800 | 125 KiB |
| `raw_events`, `metric_events`, `deduped_metric_events_state`                               | ~250  | ~35 KiB |
| `run_snapshots`                                                                            | 14    | 5 KiB   |
| `environment_exposure_status_state`, `environment_exposure_status_deletions`               | 13    | 1 KiB   |
| `deduped_exposures`, `audit_log`, `entity_deletions`, `app_identity_generation_tombstones` | 0     | 0       |

The design below is sized for growth, not for today's 230 KiB; at today's size every option works.

| Datasource                           | Why it is irreplaceable                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deduped_exposures`                  | `replace` Copy Pipe re-derived from `raw_events` on every run; once a first touch ages past the 90-day TTL, a backup taken before that is its only copy |
| `run_snapshots`                      | Run inputs frozen at Start (ADR-0047); no other copy                                                                                                    |
| `audit_log`                          | Who/what/when compliance record                                                                                                                         |
| `entity_deletions`                   | Privacy obligation record; must survive to keep deletions enforced                                                                                      |
| `app_identity_generation_tombstones` | Identity epoch fences; needed to keep old-epoch rows excluded                                                                                           |
| `environment_exposure_status_state`  | Aggregating state; rebuildable from `raw_events` only inside the 90-day window                                                                          |

The 90-day TTL families (`raw_events`, `raw_evaluations`, `metric_events`,
`deduped_metric_events_state`) are a product retention decision (ADR-0032), not a backup gap. Backups
of these families must not outlive the product retention window.

### Tier 3: Assignment Store KV

`ASSIGNMENTS_KV` is the read path for holdover sticky experience (ADR-0009). The per-key writer
Durable Objects cannot be enumerated, so losing the namespace loses holdover. Historical analysis is
unaffected because `deduped_exposures` is the analysis record; live Runs would see returning Entities
re-assigned by deterministic `assign()`, which only differs at a Run boundary (ADR-0006).

### Tier 4: rebuildable or transient, no backup

- `CONFIG_STORE` flag projections rebuild from D1 on read ([storage-map.md](./storage-map.md), "No
  internal config-copy seam"). `CREDENTIAL_STORE` rebuilds through the credential cache backfill
  Durable Object and `scripts/complete-credential-cache-backfill.mjs`.
- `SESSION_STORE`, `JTI_CACHE`, MCP session objects, rate-limit and admission-gate objects: users
  re-authenticate.
- Outbox, claim, replay-window, and reconciliation Durable Objects plus the four Queues and their
  DLQs: at most the in-flight window of telemetry is lost. DLQ contents are the only copy of rejected
  events; accept that loss and say so in the incident record.
- `splitch-privacy-exports`: artifacts are regenerated from the privacy job ledger in D1.

### External systems

- WorkOS holds Users, Organizations, and SSO connections; D1 stores only `workos_org_id` and user
  ids. Vendor durability covers hardware loss, not our own misconfiguration or environment deletion.
- Stripe is the billing ledger; D1 stores linkage only.
- GitHub holds source (distributed, fine) and the write-only secrets above.

## Recovery objectives

| Tier | Data                         | RPO                                                                             | RTO     |
| ---- | ---------------------------- | ------------------------------------------------------------------------------- | ------- |
| 0    | Root secrets and KEKs        | 0 (escrow at creation)                                                          | 1 hour  |
| 0    | Wrapped App identity records | 24 hours (immutable per epoch, so effectively "Apps created since last backup") | 1 hour  |
| 1    | D1                           | 24 hours off-store; 1 minute via Time Travel while the database exists          | 1 hour  |
| 2    | Tinybird durable datasources | 24 hours                                                                        | 8 hours |
| 3    | Assignment Store KV          | 24 hours, best effort                                                           | 8 hours |
| 4    | Everything else              | none                                                                            | rebuild |

## Design

### Backup bundle

One nightly GitHub Actions workflow, `backup-production`, on the `production` environment, produces
a dated bundle `backups/{YYYY-MM-DD}/` in a new R2 bucket `splitch-backups`:

1. `d1.sql`: `wrangler d1 export splitch-production-d1 --remote --output`. The export blocks other
   database requests for its duration; at 1.6 MB that is sub-second. Schedule at the daily low.
2. `identity/{appId}.json`: every `app:{appId}:entity-identity` value from `CONFIG_STORE`, read
   through the KV REST API (list by prefix, then get). These are ciphertext under
   `EVALUATION_PRIVACY_SALT`; storing them next to the D1 dump does not weaken the wrap. The KV
   replica may lag the Durable Object for an App created in the last minute; that is inside the RPO.
3. `tinybird/{datasource}/{slice}.parquet.zst`: written by Tinybird S3 Sink pipes into the AWS
   bucket `splitch-backups-tinybird`, then mirrored into the bundle by the workflow, which also
   verifies each object's row count against a `count()` on the source. Sinks cannot target R2, so
   this is the one step that needs AWS. Pipes, bucket, roles, and verification are specified in
   [tinybird-backup-export.md](./tinybird-backup-export.md).
4. `assignments/`: `ASSIGNMENTS_KV` keys and values through the KV REST API. Best effort; the job
   records the key count so growth past what a nightly dump can finish is visible before it fails.
5. `manifest.json`: per-file row counts and SHA-256 digests, the source SHA, and the timestamp.

Failure of any step fails the workflow. No partial bundle is marked complete. The manifest is the
last object written and its absence means the bundle is unusable.

Bucket protection: an R2 bucket lock on `splitch-backups` so objects cannot be deleted before their
retention age, and lifecycle rules that expire event-family files at 30 days and everything else at
365 days. The 30-day cap on event-family files keeps Entity deletion obligations honest: a deleted
Entity is gone from every backup within one cycle, and [privacy-data-lifecycle.md](./privacy-data-lifecycle.md)
gains a sentence stating that window.

### Off-Cloudflare copy

The R2 bundle protects against operator mistakes and per-store failures. It does not protect against
losing the Cloudflare account. The same workflow syncs the bundle to the AWS bucket the Tinybird sinks already
write to, after encrypting it with `age` to a recipient whose private key lives only in the secret
escrow. Tinybird's own objects are already there in the clear; they are pseudonymous under
`targeting_key_hash` and carry no secret. This is the only copy that survives account compromise, so it is not optional; it is phase 3
only because escrow and the R2 bundle have to exist first.

### Secret escrow

Every production secret in the Tier 0 list is copied, at creation and at every rotation, into an
offline password-manager vault owned by the founder. `scripts/sync-worker-secrets.mjs` gains a
`--fingerprint` mode that prints the SHA-256 of each value it would push and refuses to overwrite a
Tier 0 secret whose fingerprint differs from the escrowed one unless `--rotate NAME` is passed. This
is a guard on the sync script, not a deploy-time credential probe; it never contacts Cloudflare to
check a secret's value.

### Restore paths

Each path is a numbered runbook in this document once wired. Summary:

- **D1 within 30 days, database intact**: `wrangler d1 time-travel info` to pick the bookmark,
  `wrangler d1 time-travel restore` to apply. Destructive and in place. Snapshot the current
  bookmark first so the restore itself can be undone.
- **D1 from bundle**: `wrangler d1 create` a fresh database, strip `BEGIN TRANSACTION` and `COMMIT`
  from `d1.sql`, `wrangler d1 execute --remote --file`, then update every `database_id` in the
  Wrangler configs and redeploy. Config and credential KV projections rebuild from D1 on read and
  through the credential cache backfill.
- **Identity record for one App**: write the escrowed wrapped record back to the Config Store
  Durable Object through `putConfigStoreAppIdentityIfAbsent`, which already refuses to overwrite a
  present record. Needs a new admin route on the Control Plane API. Until it exists, the 30-day
  Durable Object PITR is the only path and it needs the same route to call
  `onNextSessionRestoreBookmark`.
- **Tinybird**: append the Parquet slices back with `tb --cloud datasource append`, oldest first,
  then rerun the two copy pipes; a lost workspace is recreated with `tb deploy` from `main` first.
  Full procedure in [tinybird-backup-export.md](./tinybird-backup-export.md), "Restore".
- **Assignment Store KV**: bulk write through the KV REST API (10,000 pairs per call).
- **Whole account**: create the account, provision D1, KV namespaces, R2 buckets, Queues, and DLQs
  by hand from the Wrangler configs (queues and DLQs are not provisioned by any script today; the
  privacy export bucket and queue are, in `scripts/ensure-privacy-export-resources.mjs`), restore
  secrets from escrow, run the D1 and identity restores, deploy, then Tinybird, then assignments.

### Drill

Quarterly, against a scratch D1 database and a Tinybird Branch created with
`tb branch create drill-{YYYY-MM-DD} --last-partition` (zero-copy, its own tokens and endpoints,
Enterprise allows 15), never against `shared-preview` (customer pseudonymous data does not belong in
a shared non-production target). `tb branch rm` is irreversible, so the drill name makes the
target unambiguous. The drill restores
the latest bundle, compares manifest row counts to restored counts, evaluates one Flag through the
restored Control Plane, and deletes the scratch resources. The drill date and result are appended to
this document.

## Verification

Backup success is not the workflow going green. Every bundle is verified in the same run: download
the D1 dump, import it into a local D1 with `wrangler d1 execute --local`, and compare the
per-table row counts with the manifest. Any mismatch fails the run.

## Phases

1. **Escrow and guard (first).** Copy Tier 0 secrets to the vault, add the fingerprint guard to the
   sync script, record who holds the vault. No infrastructure change. This alone removes the
   "nothing can recover it" case for the root secret.
2. **Nightly bundle to R2.** Create `splitch-backups` with bucket lock and lifecycle rules, wire the
   `backup-production` workflow with in-run verification, add the identity admin route, write the
   D1 and identity runbooks.
3. **Tinybird sinks.** Provision the AWS account, bucket, and roles; deploy the connection and
   sink pipes; add the mirror and verification steps to the workflow.
4. **Off-Cloudflare copy.** Add the encrypted sync of the D1, identity, and assignment files to
   the same AWS bucket.
5. **First drill.** Run the drill, fix what it exposes, schedule the quarterly recurrence.

## Open items

- No AWS account exists today; phase 3 starts with creating one. The R2 finding and the
  retention question on `deduped_exposures` are tracked in
  [tinybird-backup-export.md](./tinybird-backup-export.md).
- `ASSIGNMENTS_KV` key count is unknown; the first bundle run reports it.
- WorkOS Organization and User export is not in the bundle. Add it if WorkOS environment loss is
  judged plausible; D1 alone cannot rebuild logins.

## Done

- Tier 0 secrets are in the vault and the sync script refuses an unflagged overwrite.
- A dated bundle with a manifest lands in `splitch-backups` every night and the run fails loudly
  when any step or the verification does not.
- Each restore path above has a runbook that has been executed at least once in a drill.
- An encrypted copy of every bundle exists outside the Cloudflare account.
