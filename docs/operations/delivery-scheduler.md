# Delivery scheduler and D1 load

Reviewed October 5, 2026 for [SPL-690](https://linear.app/zaks-io/issue/SPL-690/reduce-delivery-scheduler-d1-query-amplification).

## What the live evidence says

The production database is 15,360,000 bytes. D1 reported 22,956 read queries and
41,384 write queries in the preceding 24 hours. Read replication was disabled.
This is a small database with a delivery workload that repeatedly does the same
failed work, not evidence that normal business writes have exhausted D1 capacity.

A production scheduler trace took 11.2 seconds and recorded 33 database spans.
Those span durations include network and queue time. D1 Query Insights reported
sub-millisecond average SQL execution for the highest-volume Convex query shapes;
these figures measure different parts of the request and must not be compared
as if they were the same latency.

At the review snapshot:

- 298 pending Convex deliveries belonged to two active installations. Each had
  attempted delivery 150 to 1,709 times with `DELIVERY_PREPARATION_FAILED`.
- Both installations used key version `v1`, their encrypted-secret envelopes had
  the expected shape, and the deployed `CONVEX_WEBHOOK_KEK` binding was present.
  Presence and shape do not prove that the current key can decrypt the records.
- 16,330 Convex deliveries were terminal after an HTTP 404 response. Another
  1,761 were delivered. No delivery-row retention job was implemented.
- The top four Query Insights shapes were Convex delivery reads and writes,
  each executed about 13,700 to 14,100 times in 24 hours.
- Sentry cursor reads ran 1,247 times and read 409,016 rows. Their existing index
  included Environment between App and sequence, which prevented an efficient
  App-only cursor range lookup.

These checks were read-only. No production data, secrets, or settings changed.

## Recent Sentry errors

The live 30-day review on October 5 returned 21 error groups, 201 events and
19 unresolved groups. The list below follows Sentry's last-seen ordering. Counts
are the counts returned by the grouped issue search, not a production-only count.
The separate performance groups SPLITCH-1A, SPLITCH-1B and SPLITCH-1C report
scheduler N+1 queries.

| Issue                                                    | Error                                                   | Events | Status     |
| -------------------------------------------------------- | ------------------------------------------------------- | -----: | ---------- |
| [SPLITCH-M](https://zaksio.sentry.io/issues/SPLITCH-M)   | Cloudflare dispatch failure, latest event D1 overloaded |      6 | Unresolved |
| [SPLITCH-J](https://zaksio.sentry.io/issues/SPLITCH-J)   | Sentry dispatch failure, latest event D1 overloaded     |      4 | Unresolved |
| [SPLITCH-19](https://zaksio.sentry.io/issues/SPLITCH-19) | Durable Object reset during code update                 |      1 | Unresolved |
| [SPLITCH-D](https://zaksio.sentry.io/issues/SPLITCH-D)   | Internal server error                                   |      1 | Unresolved |
| [SPLITCH-18](https://zaksio.sentry.io/issues/SPLITCH-18) | Experiment fetch failed                                 |      1 | Unresolved |
| [SPLITCH-Y](https://zaksio.sentry.io/issues/SPLITCH-Y)   | Rate limit exceeded                                     |     21 | Resolved   |
| [SPLITCH-17](https://zaksio.sentry.io/issues/SPLITCH-17) | Search validation rejected path                         |     71 | Resolved   |
| [SPLITCH-16](https://zaksio.sentry.io/issues/SPLITCH-16) | Members page server rendering failed                    |     16 | Unresolved |
| [SPLITCH-15](https://zaksio.sentry.io/issues/SPLITCH-15) | Flag promotion connection lost                          |      1 | Unresolved |
| [SPLITCH-14](https://zaksio.sentry.io/issues/SPLITCH-14) | Segments connection lost                                |      3 | Unresolved |
| [SPLITCH-13](https://zaksio.sentry.io/issues/SPLITCH-13) | Environment settings fetch failed                       |      1 | Unresolved |
| [SPLITCH-12](https://zaksio.sentry.io/issues/SPLITCH-12) | Metrics connection lost                                 |      1 | Unresolved |
| [SPLITCH-11](https://zaksio.sentry.io/issues/SPLITCH-11) | Experiment draft connection lost                        |      1 | Unresolved |
| [SPLITCH-C](https://zaksio.sentry.io/issues/SPLITCH-C)   | Flag connection lost                                    |      1 | Unresolved |
| [SPLITCH-10](https://zaksio.sentry.io/issues/SPLITCH-10) | Environment list query failed                           |      1 | Unresolved |
| [SPLITCH-Z](https://zaksio.sentry.io/issues/SPLITCH-Z)   | Metrics fetch failed                                    |      1 | Unresolved |
| [SPLITCH-X](https://zaksio.sentry.io/issues/SPLITCH-X)   | Search validation rejected id                           |      9 | Unresolved |
| [SPLITCH-G](https://zaksio.sentry.io/issues/SPLITCH-G)   | Exception with unhelpful captureException title         |      9 | Unresolved |
| [SPLITCH-5](https://zaksio.sentry.io/issues/SPLITCH-5)   | Unknown error on Flag page                              |     10 | Unresolved |
| [SPLITCH-B](https://zaksio.sentry.io/issues/SPLITCH-B)   | Experiment page server rendering failed                 |     12 | Unresolved |
| [SPLITCH-W](https://zaksio.sentry.io/issues/SPLITCH-W)   | Exception with unhelpful captureException title         |     30 | Unresolved |

Latest dispatch events were four days before the review; other groups last
occurred 18 to 29 days before it. An unresolved status alone does not prove a bug
still reproduces on the current release. The scheduler takes priority; remaining
groups need focused reproduction and current-release checks before fixes.

## First fix

A full 25-row claim previously used one candidate query followed by an update
and a joined read for every row: 51 D1 calls and 51 SQL statements. The replacement
uses a transactional claim/read batch: one D1 call and two SQL statements. This
removes 98% of claim round trips. It does not establish a production latency win
until the final code is deployed and measured.

The same patch guards Convex installation-health completion with lease ownership,
filters idle Sentry installations before the scan limit, and adds indexes for
expired leases and App-scoped change-log cursors. Preparation failure logs retain
an allowlisted exception type so an AES-GCM `OperationError` can be distinguished
without recording messages, stacks, keys, ciphertext, or payloads.

Each delivery still commits its acknowledgment independently. Combining every
acknowledgment into one transaction would make a single failure roll back healthy
siblings, changing the isolation established by SPL-554. Completion N+1 findings
may therefore remain after this first fix. They must not be closed on the strength
of the claim-query improvement alone.

The patch does not repair the two existing installations. Observe the new
preparation diagnostic after approved production deployment, then recover the
installation with its owner. Do not rotate the shared encryption key or change
stored ciphertext as a shortcut.

## Non-production verification

The isolated October 5 deployment used the actual repository and dispatchers,
a remote scratch D1 database with migration 0039, and a separate HTTPS receiver
Worker. Receiver signatures were checked before writing receipts. It observed:

- Convex: 25 claimed rows, one D1 call, two SQL statements; 25 verified HTTP
  receipts and delivered version 25.
- Cloudflare: 25 claimed rows, one D1 call, two SQL statements; 25 verified HTTP
  receipts and applied version 4.
- A competing Convex claimant acquired zero already-leased rows.
- Sentry: only the pending installation was selected; the consumed idle
  installation was excluded. The receiver accepted one signed batch containing
  three changes and the installation cursor advanced to sequence 43.
- The baseline deployment observed 51 calls and statements for 25 Convex claims.

Local validation passed 329 real D1 tests and 19 focused dispatcher tests.
Query-plan tests verify index range access; migration tests compare the applied
schema with the declared indexes. These synthetic checks establish the claim
budget and delivery correctness, not production throughput or latency.

## Options and recommendation

D1 executes queries serially within each database. Extra parallel requests can
fill its queue; they do not create additional write capacity. There is no larger
D1 instance setting that fixes an inefficient workload.

| Option                                      | What it solves                                                                             | Recommendation                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optimize D1 and repair failed delivery work | Repeated claims, unnecessary cursor scans, stale completions, invalid installation retries | Do first. Apply this patch, diagnose the two blocked installations, then implement bounded retention and scope immediate dispatch to the affected App.            |
| Per-Environment Durable Object coordinator  | Coalesces version nudges, serializes dispatch, schedules retries with alarms               | Preferred next architectural step if measured overload remains. Keep the transactional D1 outbox and a bounded recovery sweep.                                    |
| Cloudflare Queues as a wake-up relay        | Moves delivery execution away from request handling, adds controlled consumer concurrency  | Useful with a coordinator. Database triggers cannot enqueue directly, so preserve the outbox and recovery scan. A queue alone does not remove D1 reads or writes. |
| D1 read replication                         | Reduces primary load from eligible stale-tolerant reads                                    | Useful for read-heavy control-panel paths through Sessions. Does not increase the primary's write capacity or solve claims and acknowledgments.                   |
| Shard D1 by Organization                    | Gives independent databases separate execution capacity                                    | Consider only for demonstrated cross-Organization saturation. Requires routing and migration changes; triggers and related data must remain together.             |
| PostgreSQL through Hyperdrive               | Supports a larger shared relational write workload and row-locking claim patterns          | Consider if optimized ordinary business traffic still saturates D1. It requires a control-plane and trigger migration, not just swapping a driver.                |

Prioritize successful, bounded work over increasing scheduler parallelism. After
production approval, compare D1 query count, rows read/written, overload errors,
delivery age and successful acknowledgments under the same observation window.
Separate SQL execution duration from end-to-end D1 binding latency.

## Validation completed

- Real D1 tests passed the constant claim budget and lease/retry/version invariants.
- Idle-installation selection and Organization isolation passed regression tests.
- The additive migration and declared schema agree, and query plans use the indexes.
- Required local checks, a fresh local cross-review and GitHub CI passed.
- CodeRabbit reviewed the runtime and index changes without code findings.
- The deployed non-production proof exercised the changed claims and verified
  signed webhooks received and acknowledged over HTTPS against a real D1 database.

## Pending release

- Explicit approval to merge and promote to production. Merging starts production
  deployment through the existing pipeline.
- Production measurements of query load, overload errors and delivery age.
- Diagnosis and owner-assisted recovery of the two blocked Convex installations.

## Sources

- [D1 concurrency and throughput](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput)
- [Transactional D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [D1 Sessions and read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Hyperdrive](https://developers.cloudflare.com/hyperdrive/get-started/)
- [Integration storage and delivery contract](../spec/contracts/storage-schemas-d1-integrations.md)
- [Convex delivery contract](../adr/0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)
- [Flag log and Sentry cursor contract](../adr/0051-the-flag-change-log-is-both-the-audit-record-and-the-integration-outbox.md)
