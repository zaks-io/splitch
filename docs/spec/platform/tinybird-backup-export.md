# Tinybird backup export

Status: designed, not wired. Companion to
[backup-and-disaster-recovery.md](./backup-and-disaster-recovery.md), which owns tiers, objectives,
the bundle layout, and the drill. This document owns the Tinybird half: what the vendor offers, which
export path the nightly bundle uses, why, and when to switch. Facts below were verified against the
`splitch_prod` workspace and the `tb` CLI (4.6.12) on 2026-09-08.

## What the vendor provides

| Capability             | What it is                                                                                                              | Usable for our backups                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Vendor backup          | Daily, kept 2 days, whole-workspace rollback opened through support ([security page](https://www.tinybird.co/security)) | Last resort only, under 48 hours       |
| S3 Sink pipes          | Scheduled pipe result written to AWS S3 as CSV, NDJSON, or Parquet                                                      | Yes, but needs an AWS account          |
| GCS Sink pipes         | Same, to Google Cloud Storage                                                                                           | Same shape, needs a GCP account        |
| Query API              | `POST /v0/sql` with `FORMAT Parquet`, `JSONEachRow`, or `CSVWithNames`; 100 MB result, 30 s on Enterprise               | Yes, sliced per datasource and day     |
| `tb datasource export` | Query API wrapper, CSV or NDJSON, `--rows` and `--where`                                                                | Ad-hoc only                            |
| Branches               | `tb branch create <name> --last-partition`, zero-copy, own tokens and endpoints                                         | Drill target, not a backup             |
| Copy pipes             | `cp_deduped_exposures` (replace) and `populate_metric_event_delivery_state` (append), both on demand                    | Rebuild derived tables after a restore |
| Append ingest          | `tb datasource append`, `POST /v0/datasources?mode=append` (5 per minute), S3 connector `@once` for bulk                | Restore path                           |

Plan limits that shape the design ([limits](https://www.tinybird.co/docs/forward/pricing/limits)):
Query API 100 MB per result and 30 s per query; Sinks 10 per workspace, 300 s per run, 16 files per
run, 6 active jobs; append 5 calls per minute, Parquet 5 GB per file, 32 GB uncompressed; branches
default 4 on shared infrastructure.

## Sinks cannot target R2

Verified from the CLI source, not only the docs, after this was challenged on 2026-09-08:

- The S3 connection accepts exactly four keys: `S3_ARN`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET`
  (`tinybird/tb/modules/datafile/format_connection.py`, `S3_SETTINGS_ORDER`). The server-side
  connector settings list (`tinybird/tb/modules/connection.py`) has the same shape plus an external
  id for the IAM role form. There is no endpoint, host, or URL key anywhere in the package.
- R2's S3 API lives at `<account>.r2.cloudflarestorage.com` and must be selected by endpoint
  ([R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)). Without an endpoint field an
  S3 client always talks to AWS.
- The [S3 Sink docs](https://www.tinybird.co/docs/publish/sinks/s3-sink) state "Amazon S3 is the
  only service Tinybird's Sink Pipes support" and list AWS regions only.
- The CLI marks the access-key form deprecated ("S3 (Access Key + Secret) connector is deprecated.
  Use S3 IAM role instead."). That is the only form an R2 token could plug into; R2 has no IAM
  roles.

No empirical test was run because there is no configuration to test. Re-evaluate if Tinybird ships
an endpoint setting; the sink path would then drop the AWS account requirement.

## Decision: S3 Sinks into an AWS bucket, mirrored into the R2 bundle

Tinybird writes each durable datasource to an AWS S3 bucket through Sink pipes on a nightly
schedule. The `backup-production` workflow then mirrors the night's objects from S3 into the R2
bundle so one manifest covers every store. This is the vendor-supported bulk export path, it has no
per-query result cap, and the AWS bucket is at the same time the off-Cloudflare copy for Tier 2. The
cost is one more account to operate. Decided 2026-09-08: the plan is sized for a disaster years
out, not for today's 230 KiB, and a second provider is required anyway for the off-Cloudflare copy.

The Query API is the ad-hoc and fallback path (`tb datasource export`, or `POST /v0/sql` with
`FORMAT Parquet`), capped at 100 MB per result and 30 s per query. It is used for a one-off snapshot
before a destructive deploy when a sink cannot run, and for nothing scheduled.

### AWS resources

Provisioned by hand once, recorded here so a rebuild has the exact names:

| Resource                             | Value                                                                                                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS account                          | dedicated `splitch-backups` account (new; no AWS account exists today)                                                                                                                                                                                               |
| Bucket                               | `splitch-backups-tinybird`, region `us-west-2` (same region as the workspace, $0.01/GB)                                                                                                                                                                              |
| Bucket protection                    | versioning on, Object Lock in compliance mode with a 30-day default retention on event-family prefixes and 365 days elsewhere, public access blocked, default SSE-S3                                                                                                 |
| Lifecycle                            | expire `tinybird/raw_events/`, `tinybird/raw_evaluations/`, `tinybird/metric_events/` at 30 days; everything else at 365 days                                                                                                                                        |
| IAM role for Tinybird                | `tinybird-sink-writer`, trust policy from the S3 Sink docs with the Tinybird principal and `sts:ExternalId`; permissions `s3:GetObject`, `s3:PutObject`, `s3:PutObjectAcl` on `splitch-backups-tinybird/*` and `s3:GetBucketLocation`, `s3:ListBucket` on the bucket |
| IAM identity for the mirror          | GitHub OIDC provider plus role `splitch-backup-mirror`, trust limited to `repo:zaks-io/splitch:environment:production`, read-only on the bucket                                                                                                                      |
| Tinybird secret                      | `BACKUP_S3_ROLE_ARN` holding the writer role ARN, set with `tb secret set`                                                                                                                                                                                           |
| GitHub `production` environment vars | `AWS_BACKUP_ROLE_ARN`, `AWS_BACKUP_BUCKET`, `AWS_BACKUP_REGION`; no long-lived AWS keys                                                                                                                                                                              |

### Sink pipes

`infra/tinybird/connections/backups_s3.connection`:

```text
TYPE s3
S3_REGION "us-west-2"
S3_ARN {{ tb_secret("BACKUP_S3_ROLE_ARN") }}
```

One `infra/tinybird/sinks/sink_{datasource}.pipe` per exported datasource, `TYPE sink`,
`EXPORT_CONNECTION_NAME backups_s3`, `EXPORT_BUCKET_URI s3://splitch-backups-tinybird/tinybird/{datasource}`,
`EXPORT_FORMAT "parquet"`, `EXPORT_COMPRESSION "zst"`, `EXPORT_STRATEGY "replace"`, and
`EXPORT_SCHEDULE` at the daily low, staggered one minute apart so the 6-active-job limit is never
hit. Enterprise allows 10 sinks per workspace; nine datasources are exported, leaving one spare.
The deploy script keeps `--allow-destructive-operations` out; the sinks deploy through the normal
pipeline like any other pipe.

| Datasource                                                         | Slice column         | File template                      | Exported                       |
| ------------------------------------------------------------------ | -------------------- | ---------------------------------- | ------------------------------ |
| `raw_events`                                                       | `server_received_at` | `{server_received_at, '%Y-%m-%d'}` | yes, last 30 days per run      |
| `raw_evaluations`                                                  | `server_received_at` | same                               | yes, last 30 days per run      |
| `metric_events`                                                    | `server_received_at` | same                               | yes, last 30 days per run      |
| `audit_log`                                                        | `timestamp`          | `{timestamp, '%Y-%m-%d'}`          | yes, all                       |
| `entity_deletions`                                                 | `requested_at`       | `{requested_at, '%Y-%m-%d'}`       | yes, all                       |
| `deduped_exposures`                                                | none                 | `full`                             | yes, whole table nightly       |
| `run_snapshots`                                                    | none                 | `full`                             | yes                            |
| `app_identity_generation_tombstones`                               | none                 | `full`                             | yes                            |
| `environment_exposure_status_deletions`                            | none                 | `full`                             | yes                            |
| `deduped_metric_events_state`, `environment_exposure_status_state` | n/a                  | n/a                                | no, aggregating state; rebuilt |

Day-partitioned sinks select the last 30 days of the datasource each night and replace the day
files, so late-arriving rows are captured and a deleted Entity is gone from every backup within
one cycle. Full-table sinks replace one object nightly. Each sink pipe takes a `day_from` and
`day_to` parameter so `tb sink run <pipe> --wait --param day_from=... --param day_to=...` can
backfill a range or take an ad-hoc snapshot before a deliberately destructive deploy.

### Manifest and verification

The workflow does not trust a green sink. After the scheduled sinks have run it:

1. Lists the night's objects in S3 and mirrors them into `backups/{YYYY-MM-DD}/tinybird/` in the
   R2 bundle, unchanged.
2. Reads `tinybird.sinks_ops_log` for the night and fails the run if any sink for an exported
   datasource is missing or not `done`.
3. Runs `SELECT count()` per day slice and per full table through the Query API with the scoped
   read token, reads the Parquet row count from each mirrored object's footer, and fails the run on
   any mismatch. Counts, sizes from `tinybird.datasources_storage`, and the sink job ids go into
   `manifest.json`.

### Token

A static token `backup_reader` with `DATASOURCES:READ:<name>` for each exported datasource plus
read on `tinybird.sinks_ops_log` and `tinybird.datasources_storage`, created through
`POST /v0/tokens` (the CLI cannot copy tokens to the clipboard; see
[deployment-pipeline.md](./deployment-pipeline.md)). Stored as the GitHub environment secret
`TB_BACKUP_TOKEN` on `production`. The deploy token `TB_TOKEN` is not reused; it can write.

Reading whole datasources with that token is an operator job. It does not violate invariant 5 in
[README.md](./README.md) ("Tinybird is never queried directly"), which governs product reads that
must carry `app_id`; the backup carries every App by design and never serves a user.

## Restore

- **Rows or a datasource lost**: an S3 connector datasource pointed at
  `s3://splitch-backups-tinybird/tinybird/{datasource}/**` with `IMPORT_SCHEDULE @once` and
  `tb datasource sync` ingests straight from the bucket (5 files per minute). For a few objects,
  `tb --cloud datasource append <datasource> <file>` per Parquet object, oldest slice first. Then `tb copy run cp_deduped_exposures` and
  `tb copy run populate_metric_event_delivery_state` to rebuild the replace and aggregating targets.
- **Workspace gone**: `tb deploy` from `main` recreates every datasource and pipe, then the append
  path above. Tinybird support can roll the workspace back to its daily backup if the loss is under
  two days old; that discards everything ingested since.
- **Drill**: a Branch `drill-{YYYY-MM-DD}` created with `--last-partition`, restore into it, compare
  manifest counts, `tb branch rm` it. Never `shared-preview`.

## Open items

- `deduped_exposures` is a `replace` copy re-derived from `raw_events` on every run, so a first
  touch older than 90 days survives only in this backup. Whether it should survive at all is an
  ADR-0032 retention question; the nightly full-table export keeps it either way for 365 days.
- The 30-day re-export window on the event families is bounded by the 300 s sink run limit. At a
  volume where one datasource's 30 days no longer sinks in 300 s, narrow the window to 7 days and
  rely on the bucket's own retention for the rest; the manifest sizes make that visible early.

## Done

- The AWS bucket, both IAM roles, and the Tinybird secret exist with the names above, and the
  bucket rejects a delete inside the retention window.
- Nine sink pipes and the connection are deployed to `splitch_prod` through the normal pipeline
  and `tinybird.sinks_ops_log` shows a `done` run for each.
- `TB_BACKUP_TOKEN` exists on the `production` environment and can only read.
- The nightly bundle contains every mirrored object with a manifest count that matches a `count()`
  run in the same job, and a deliberately missing sink run fails the workflow.
- One drill has restored a bundle into a Branch and the counts matched.
