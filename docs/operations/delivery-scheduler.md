# Delivery scheduler and D1 load

Reviewed October 5, 2026 for [SPL-690](https://linear.app/zaks-io/issue/SPL-690/reduce-delivery-scheduler-d1-query-amplification).

## Delivery-lag objective

A healthy installation should receive each committed Environment version within
10 s at p99 and 60 s worst case. These are delivery objectives, not measured
latencies established by this change.

The minute cron reads outstanding `pending` and `leased` work once per provider,
using delivery state indexes and scoped installation index lookups. It never scans
delivered, terminal, or suppressed history. It emits one `integration-delivery-lag`
event per provider, App, and Environment with healthy work, including `provider`,
`appId`, `environmentId`, `oldestAgeMs`, and `healthyInstallationsWaiting`.
Multiple outstanding versions count as one waiting installation.

Healthy means active with no `latest_delivery_error_json`. Convex also requires
`preparation_retry_at` to be absent or at or before the tick time. Cloudflare has
no preparation cooldown field, so its recorded delivery error is the equivalent
health signal. Retry schedules and unexpired leases do not hide outstanding work.

An oldest age strictly greater than 5 minutes reports `integration_delivery_lagging`
once per provider and Environment per minute tick. A failed provider read reports
`integration_delivery_lag_read_failed` independently and cannot block dispatch or
the other provider's report. The daily 08:00 UTC cron does not run this check.

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

## Follow-up remediation, October 5

[SPL-695](https://linear.app/zaks-io/issue/SPL-695/bound-integration-delivery-failures-and-enforce-30-day-retention)
adds newest-only Convex claims, installation preparation cooldown, App-scoped immediate Cloudflare
claims and the existing 30-day delivery retention contract. These changes require an approved
release and migrations 0040/0041 before production use.

Convex preparation failure now contributes at most one candidate per installation and defers
that installation for 30 minutes. This fixed delay keeps the existing maximum recovery delay,
while eliminating the multiplicative retry work from hundreds of historical rows. Scoped secret
rotation clears the delay immediately. The failure transaction compares claimed ciphertext and
key version, so a stale worker cannot delay a repaired installation. Missing or malformed KEK
configuration fails before acquiring leases. Healthy acknowledgments remain independent.

Claims start from cooldown-eligible active installations and use a partial outstanding-version
index to select one row per installation. A real D1 regression measures identical claim rows read
before and after a blocked installation grows from one to 300 pending versions. Pending history
is preserved until successful acknowledgment, avoiding premature retention aging during failure.

Only the newest outstanding Convex version is sent. A successful owned acknowledgment suppresses
older pending versions and abandoned expired leases, preserving unexpired leases. Terminal responses do not suppress older versions; those remain eligible
under the existing delivery contract. The scheduler emits separate claimed, received-2xx,
receiver-rejected, transport-failed and preparation-failed-installation counts. A received 2xx
counter records receiver response, not proof that D1 acknowledgment committed.

Completion triggers stamp both outboxes and clear the timestamp on rearm. Known delivered times
survive migration; unknown legacy terminal and suppressed completion times start a new 30-day
window. The daily 08:00 UTC job deletes at most 1,000 completed rows per provider. Pending and
leased rows are preserved. Reaching either deletion budget emits a warning and a fault report,
so a saturated backlog cannot grow silently; retained history may exceed 30 days until capacity
is adjusted. Cloudflare re-registration recreates the current-version row if
retention removed it, preserving setup recovery.

A local HTTPS proof used the actual migrated D1 repository and dispatcher with a signature-checking
receiver. One broken installation with 300 outstanding versions occupied one claim slot while a
healthy sibling completed. A second tick before cooldown expiry claimed zero. Scoped repair then
delivered version 300, verified the signature and suppressed 299 older rows. Both actual HTTPS
receipts were checked. This proves recovery correctness, not production throughput.

Before the first production pruning run, use count-only queries with the intended cutoff:

```sql
SELECT state, COUNT(*) AS eligible
FROM config_webhook_deliveries INDEXED BY config_webhook_delivery_completed_idx
WHERE state IN ('delivered', 'terminal', 'suppressed') AND completed_at < ?
GROUP BY state;
SELECT state, COUNT(*) AS eligible
FROM cloudflare_config_deliveries INDEXED BY cloudflare_config_delivery_completed_idx
WHERE state IN ('delivered', 'terminal', 'suppressed') AND completed_at < ?
GROUP BY state;
```

Bind the proposed scheduled run time minus 30 days. Before migration, only delivered rows with
known timestamps can be initially eligible; legacy failures wait 30 days from migration. Production
release and permanent pruning need explicit approval. Recover affected secrets through the owning
installation's existing authenticated rotation operation and matching receiver update. Never
replace the shared KEK or patch ciphertext as a shortcut.

## Follow-up, October 25: dead preview installations starved Production

Neuron's Production installation sat 20 minutes behind five pending versions while the
dispatcher claimed only Dev rows. Dev had 437 active installations; 405 last received HTTP 404
because their Convex previews were deleted. Each tick, a dead installation's newest version went
terminal and exposed its next older pending version. That row had an earlier `next_attempt_at`
than Production's, so it sorted ahead again. Twenty ticks produced 496 terminal 404s and no
Production attempt, with 1,614 older Dev rows still ahead of it. An approved one-row
`next_attempt_at` change moved Production's newest version to the front; it was delivered on the
next tick and superseded the four older versions.

Terminal responses now suppress older pending versions, as successes already did. The webhook is
a version-only nudge, so an older version cannot succeed where the newer one was rejected.
Claims now go to the installation that has waited longest, and a failing installation's wait
counts from 30 minutes later. A fan-out to dead receivers no longer queues ahead of healthy
installations that change within 30 minutes of it, in any App. The penalty orders work; it does
not bound delay, which still depends on backlog and the 25-row claim. The wait starts at the
oldest outstanding version and restarts after each attempt (the installation's `updated_at`), so
config churn cannot starve a recovering installation and a receiver that keeps failing cannot
hold the front. Dead preview installations still receive one attempt per Environment version
until they are revoked.

## Per-Environment coordination, October 25

[SPL-788](https://linear.app/zaks-io/issue/SPL-788) implements
[ADR-0061](../adr/0061-integration-delivery-runs-on-a-per-environment-coordinator.md).
Each Environment's `IntegrationDeliveryDurableObject` claims and sends its own Convex and
Cloudflare work. Another Environment's backlog cannot spend its claim slots or executor time.
D1 remains shared, so database contention still affects both Environments.

A coordinator run claims at most six Convex rows and sends all six concurrently, then does the
same for Cloudflare. No claimed delivery waits behind another send. It repeats until a pass
claims nothing, 60 seconds elapse, or the run claims 1,000 rows. The last claim shrinks to the
remaining row budget. Once that budget is spent, the run finishes its claimed rows and schedules
an immediate alarm for a fresh invocation. The measured per-attempt cost is about 1.34 D1 calls
plus one receiver HTTP call. Allowing one deletion probe and one lease renewal for every row
still uses about 4,340 subrequests, leaving room below the
[10,000-per-invocation default](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
for scheduling and other work.

The nominal 30-second lease budget includes 5 seconds of preparation, 5 seconds of HTTP and
10 seconds of D1 completion. Preparation can exceed its allowance. Each row carries its claimed
lease deadline into the send path. Immediately before HTTP, a live clock checks that the lease
still covers the send allowance plus completion. If fewer than 15 seconds remain, one guarded
UPDATE renews the lease for 30 seconds only while the row is leased, owned by this dispatcher and
unexpired. A zero-row renewal skips HTTP and completion, leaves the row with its current owner,
and increments `skippedLeaseLost` in the provider summary. Cron Cloudflare still has no HTTP
timeout; its renewal check uses the same nominal 5-second send allowance. This guard applies to
both policies, independently of cron's fixed claim clock.

A module check includes all three nominal budgets and rejects a claim larger than the send concurrency.
A real-D1 contention test with 25 rows, 4.8-second responses and 2-second completions proves that
a competing dispatcher cannot reclaim an in-flight row at 31 seconds. Additional real-D1 tests
delay preparation to 27 seconds for both providers and policies, then compete at 31 seconds while
HTTP is in flight. Preparation that outlasts the lease, or a reclaim by another owner, skips sending.

Dispatch policy comes from the caller. Cron preserves the existing 25-row concurrent batch,
5-second Convex timeout, no Cloudflare timeout and claim-time outcome/retry timestamps. The
coordinator uses six-row claims, a 5-second timeout for both providers and response-time outcomes.
The merge is behavior-neutral in cron mode except a double-send guard on nearly expired leases.
Claims retain the existing ordering, suppression and lease ownership checks. Environment-selective
Cloudflare due and expiry indexes prevent another Environment's backlog from amplifying reads.
Both providers' payload reads use partial lease-owner indexes. Real-D1 rows-read regressions stay
flat as another Environment grows from one to 1,000 pending rows or leases. The partial outstanding
indexes keep next-wake reads out of completed history.

The only coordinator storage is its identity and alarm. Alarms follow outstanding retries,
lease expiry and preparation cooldowns directly. A wake received during a run retains its earlier
alarm. Cloudflare documents that `getAlarm()` inside a running handler returns null until a new
alarm is set, so a consumed alarm does not cause a retry loop. Handler errors report
`integration_delivery_run_failed` and schedule 30 seconds later. Each run emits
`integration-delivery-run` with scope, provider claim/outcome counts, duration and next wake.

Successful mutating requests wake due Environments in the resolved App. Registration and Convex
secret rotation wake the credential-bound Environment. The minute job only wakes due
Environments in coordinator mode and sends no receiver HTTP. It recovers dropped wakes and
background mutations listed in the storage contract's config-version wake audit. Sentry retains
its Organization-scoped cursor and minute dispatch.

### Rollout

1. Deploy the additive indexes and binding with production `INTEGRATION_DELIVERY_MODE=cron`.
   This preserves global cron dispatch and immediate App-scoped Cloudflare dispatch, with the
   double-send guard on nearly expired leases.
2. Verify `coordinator` mode in shared preview, including alarms, isolation, retries, faults,
   receiver acknowledgments and D1 load. Local and shared-preview Wrangler values already select it.
3. With explicit production approval, flip production to `coordinator`. Compare healthy receiver
   delivery latency, claim/outcome logs, outstanding age and D1 contention. Roll back to `cron`
   using the same leases if needed. A stale coordinator alarm in cron mode sends nothing.
4. Delete the global dispatcher one release after production runs in coordinator mode.

No deployment or production mode flip is part of this PR.

### Local workerd load test

Run on demand, outside CI:

```sh
pnpm --filter @splitch/control-plane-api exec vitest run --config vitest.config.delivery-load.ts --maxWorkers=1
```

The three-minute run uses real local workerd alarms, migrated D1, encrypted installation secrets,
config-version triggers, claims and acknowledgments. Env A has 1,000 Convex installations, split
evenly between HTTP 404 and 500, with a config change every 10 seconds. Deterministic receiver
latencies are 100 ms for 40%, 1.2 seconds for 20%, 4.8 seconds for 20%, and 5.2 seconds for 20%.
The last group exercises the real 5-second abort signal. Env B has five HTTP-200 installations,
30 ms receiver latency and a config change every two seconds. Only outbound receivers are faked.
Latency is `delivered_at - created_at` from D1; trigger commit times have one-second precision.
Every Env B delivery must complete, including intermediate versions, before results are recorded.

The October 25 run measured 180,004 ms of workload. All 450 Env B deliveries completed, with
p50 585 ms, p99 753 ms and maximum 755 ms. Env A attempted 222 deliveries, or 1.23 attempts per
second, while receivers returned failures or timed out. The healthy Environment met the p99
10-second target. These local figures do not establish production D1 latency or capacity.
