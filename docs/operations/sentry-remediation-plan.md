# Sentry remediation plan

Reviewed October 5, 2026 at approximately 21:45 UTC. Scope is the `splitch`
project in the `zaksio` Sentry organization. This is a plan, not authorization
to change production, rotate secrets, delete data, or change issue statuses.

Start with failed Convex installation recovery. The scheduler query fix is
already deployed and early latency measurements improved, but failed preparation
continues to create repeated database work.

## Evidence and limits

- The 90-day unresolved search returned 46 groups. Nine groups were active in
  the past seven days: seven scheduled N+1 groups and two dispatch error groups.
  These are grouped findings, not nine independent root causes.
- Production error-event search over seven days returned three events each for
  [SPLITCH-M](https://zaksio.sentry.io/issues/SPLITCH-M) and
  [SPLITCH-J](https://zaksio.sentry.io/issues/SPLITCH-J). Their latest events on
  October 1 share a trace and report D1 overload while claiming Cloudflare
  deliveries and selecting Sentry installations.
- [SPL-690](https://linear.app/zaks-io/issue/SPL-690/reduce-delivery-scheduler-d1-query-amplification)
  is Done. Commit `84d63afe2c484cdf546da10d4b055cde1bfc4e8d` is both this
  worktree's head and current `origin/main`. GitHub production deployment
  `6866300195` reports success at 18:01:59 UTC on October 5.
- SPLITCH-1A/1B/1C/1D's latest inspected events used Worker version
  `3d2a3dd1-4490-446f-8cab-f8971ebbb676`, before the deployment completed.
  SPLITCH-1E/1F/1G use version `3a83a87b-bf5a-4d13-a4c3-1c168333c150` and still
  report Convex installation-health completion writes afterward.
- In the preceding 24-hour search window, production scheduled timer spans
  before 17:55 UTC had p50 2.63 seconds and p95 10.64 seconds across 843 spans.
  After 18:02 UTC, p50 was 0.507 seconds and p95 1.051 seconds across 160 spans.
  These are unequal, sampled windows, not a controlled throughput comparison.
- A post-deployment example,
  [trace 4bc698babedbdcfbad51823e52e44b97](https://zaksio.sentry.io/explore/traces/trace/4bc698babedbdcfbad51823e52e44b97),
  took 481 ms, had 11 DB spans, and reported no errors. Independent completion
  transactions still appear as repeated spans.
- Axiom's `cloudflare` dataset, filtered to the production Control Plane Worker
  from 18:02 UTC to approximately 21:44 UTC, returned 2,142 log records containing
  `convex_webhook_delivery_preparation_failed`. All contained `OperationError`.
  Code and the wrong-key regression test associate this diagnostic with failed
  WebCrypto preparation. This is consistent with AES-GCM decryption failure;
  it does not prove which key or stored record is wrong.
- [The prior read-only D1 investigation](./delivery-scheduler.md) found 298
  pending deliveries across two active Convex installations, with 150 to 1,709
  attempts each, plus 16,330 terminal HTTP 404 deliveries. Those row counts are
  prior evidence, not a fresh database measurement from this review.
- Native Worker logs route to Axiom. The Sentry log search returned no preparation
  diagnostics, so a quiet Sentry error list does not establish healthy delivery.

## Priority 1: recover failed Convex installations

First perform read-only checks through the owning App's authorized integration
operations. Refresh affected installation status, pending count, oldest pending
age, callback identity, and last delivered version. Match preparation diagnostics
to those installations without exposing keys, ciphertext, or payloads.

Then prepare owner-assisted recovery using the existing registration and secret
rotation operations. Determine whether a known working key can decrypt the
affected records or whether the installation must be re-established. Preserve
healthy installations and outstanding delivery evidence. Do not replace the
shared encryption key to repair two records.

Production recovery needs explicit approval once the exact affected installations,
action, and effects are known. This plan does not grant that approval.

Done when an affected installation receives a correctly signed configuration
nudge, acknowledges it, and advances its delivered version. Its pending age must
decrease, preparation failures must stop, and a healthy sibling must still deliver.

## Priority 2: bound repeated failed delivery work

Make a follow-up slice after SPL-690. Its scope is failed preparation and
unnecessary dispatch work, not another rewrite of the completed claim optimization.

- Diagnose repeated preparation failure once per installation and introduce a
  bounded installation-level retry/backoff policy. Retain outstanding deliveries
  and provide an explicit recovery path after credentials or configuration change.
  Decide and document the retry policy before implementation. The current
  `retryDelayMs()` caps the delay but does not cap attempts.
- Keep bounded cause-type diagnostics and add operational counts for preparation
  failures, successful acknowledgments, pending age, and retry volume. Extend
  existing observability emitters; retain current scrubbing.
- Scope immediate Cloudflare dispatch to the App affected by the committed
  mutation. `control-plane-app-request.ts` currently starts a global scan after
  every successful non-GET/non-HEAD request. Keep the bounded global recovery cron.
- Preserve independent completion transactions, lease-owner checks, revocation,
  and healthy-sibling isolation. SPLITCH-1E/1F/1G alone do not justify combining
  acknowledgments into one transaction.

Expected files include `convex-webhook-dispatch.ts`, `webhook-transport.ts`,
`control-plane-app-request.ts`, integration repositories, contracts, and their tests.
Installation-level scheduling may require an additive migration. Keep that change
explicit and review its recovery and Organization isolation behavior.

Verify against real D1 with two healthy installations and one permanently failing
installation, concurrent claimants, expired leases, revocation, and a repaired
installation. A failure must not monopolize claim capacity or roll back a healthy
acknowledgment. Exercise signed HTTPS delivery, not only mocked repository tests.

## Priority 3: implement the existing delivery retention contract

The integration storage spec already requires 30-day retention for delivered,
terminal, and suppressed rows. The current repositories have no scheduled
delivery-row retention operation. Flag change-log retention is a different job.

Add indexed, bounded daily pruning for both `config_webhook_deliveries` and
`cloudflare_config_deliveries`. Establish an accurate terminal timestamp before
using it as the retention boundary; do not infer terminal age from row creation
when a row may have retried for months. Preserve pending and leased rows and retain
the complete bounded diagnostic envelope for the specified 30 days.

This can proceed independently of installation recovery. Validate cutoff
boundaries, long-lived retries, concurrent completion, batch limits, and schema
parity using real D1. Prepare a count-only production dry run before requesting
approval for the deletion job's first production execution.

## Priority 4: verify and clean up historical groups

Use the current release and environment as the acceptance boundary. The table
identifies representative evidence; it does not claim every historical event in
a group has the same cause.

| Groups                                                    | Evidence                                                                                                                                                                                               | Action                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPLITCH-1, 5, G, W                                        | Undefined route errors are covered by completed SPL-627 and commit `57909ffb`. Current callbacks accept the thrown error directly. G's latest event is a preview scanner request; 5's latest is PR CI. | Verify current production reporting preserves a real exception, then resolve the old groups with fix evidence. Avoid a new reporting refactor.                                                        |
| SPLITCH-X and resolved SPLITCH-17                         | Old strict search validation rejected unrelated `id` or `path` parameters. Commit `850f2aa6` now uses a stripping `z.object` schema.                                                                   | Verify `id`, `path`, and tracking query parameters load successfully while invalid supported parameters still fail. Resolve X after verification.                                                     |
| SPLITCH-B and 16                                          | B's latest event is PR CI rendering a missing Experiment Run. 16's latest is local startup with an unbuilt `@splitch/sdk` entry.                                                                       | Reproduce with the current seeded fleet and dependency build. Fix an actual current empty/error-state or startup failure if present. Completed SPL-650 already isolates local E2E from hosted Sentry. |
| SPLITCH-D, K, 19                                          | D's latest evaluation 500 and K/19 report Durable Object resets during code updates.                                                                                                                   | Test deployment interruption at the affected operations. Retry only where idempotency is established; retain observable failures and honest retry guidance. Do not suppress all resets.               |
| SPLITCH-C, 8, 10, 11, 12, 13, 14, 15, 18, Z               | Old fetch, local D1 query, and connection-loss reports across panel routes.                                                                                                                            | Verify current server-failure/offline states and recovery. Do not add blanket retries to mutations.                                                                                                   |
| SPLITCH-2, 3, 4, 6, 7, 9, A, E, F, H, N, P, Q, R, S, T, V | No activity in the past seven days. Includes old local import, rate-limit, hydration, redirect, authority, and header failures.                                                                        | Check representative events and existing fixes before opening implementation work. An unresolved label is insufficient evidence of a current defect.                                                  |

The current route/search regression suites passed 23 tests in two files during
this review. They support the existing fixes but do not replace a production
browser check. No application browser flow was exercised for this planning task.

## Order and Done

Recover the affected installations first. Measure the repaired workload, then
implement bounded failure handling and scoped dispatch. Retention can run as a
separate slice. Historical verification can proceed alongside these steps.

After an approved release, compare equal 24-hour windows of scheduler duration,
D1 calls and rows read/written, overload errors, oldest pending age, and successful
acknowledgments. Early latency improvement does not prove the backlog is draining.

The remediation is done when:

- Affected and healthy integrations both receive and acknowledge current versions.
- Deterministic preparation failures have bounded work and a tested recovery path.
- Scheduler claims retain the one-RPC/two-statement budget from SPL-690, and the
  representative workload produces no D1 overload during the verification window.
- Terminal retention meets the 30-day contract without deleting outstanding work.
- Historical groups have current reproduction evidence or a documented fix before
  their Sentry status changes. Unexpected production failures remain observable.

Consider a per-Environment Durable Object coordinator only if the repaired,
bounded workload still overloads D1. Preserve the transactional outbox and recovery
sweep. Queue, sharding, and PostgreSQL migrations are conditional follow-ups.

## Implementation status

[SPL-695](https://linear.app/zaks-io/issue/SPL-695/bound-integration-delivery-failures-and-enforce-30-day-retention)
implements bounded preparation work, newest-only Convex recovery, scoped Cloudflare dispatch and
completion-based retention. The fixed 30-minute cooldown preserves the existing maximum retry
interval while limiting each installation to one preparation attempt per window. Scoped secret
rotation resets it immediately. Independent delivery completion transactions are preserved.

A read-only production refresh at 22:06 UTC confirmed two active installations in the same
App and Environment, each with 149 pending deliveries, last delivered version 87, oldest pending
August 29 and maximum attempt count 1,719. The affected installation IDs are
`218aa35c-3d62-46ae-9599-43758ed14f92` and `de5b9075-4a25-4f3b-9963-7f468b9a5829`.
Recover each through its owning App's authenticated secret rotation and matching receiver update;
retained ciphertext has not been decrypted or changed during this work.

A pre-migration count-only retention query with cutoff `2026-09-05T22:00:00.000Z` found 118
eligible Convex delivered rows and zero Cloudflare rows. All 298 outstanding Convex rows remain
preserved; 16,330 legacy Convex terminal rows and one Cloudflare terminal row receive migration-time
completion timestamps and wait a full 30 days. Refresh these counts at the approved run cutoff.
No production writes or deletion ran.

Local signed HTTPS recovery passed with 300 versions on a broken installation and one healthy
sibling. Repair delivered the newest version and suppressed 299 older pending rows. Seeded Control Panel browser checks also loaded the Flag matrix with `id`, `path` and tracking
parameters, and rendered an intentional 404 surface for a missing Experiment. These checks do not
replace production verification. Production
installation recovery, release, the first deletion run and historical Sentry status changes remain
separate actions requiring the applicable verification and approval.

## Local validation and handoff

The final expired-lease regression run passed 55 tests across completion, claims,
preparation backoff and query plans. A successful owned acknowledgment suppresses
older pending and expired leased rows, clears their lease data and preserves
unexpired leases. Stale completion cannot change the suppressed row or installation.
The receiver already accepts stale nudges as duplicates, so this follow-up prevents
redundant requests rather than correcting a receiver failure.

The earlier full DB suite passed 355 tests and the full Control Plane API suite
passed 1,417 tests. Subsequent focused runs cover the final retention saturation
signal and lease changes. Package lint/typecheck, formatting, spec/docs checks,
staged secret scanning, fresh and populated D1 migration validation and all 16
Tinybird local tests passed. Real signed HTTPS recovery and seeded browser checks
provide the local flow evidence described above.

Fresh Claude working-tree reviews identified blocked-history scan amplification,
silent retention saturation and redundant expired-lease replay. All three have
scoped fixes and regression coverage. The final suppression predicate and its
owner, revocation and unexpired-lease guards received local author QA. These are
working-tree reviews, not independent evidence for a committed PR.

The initial `pnpm verify:push` gate was blocked by `EACCES` when Knip's Vite
config loader read the worktree's `.env.local` link under Unix user `dev`.
Provisioning was repaired before the resumed verification: the T3 session now
runs as `p-splitch` and the existing Splitch dotenv link is readable. No secret
contents were printed and no access controls or hooks were bypassed. The required
`pnpm verify:push --concurrency=2` gate passed after access was restored. Normal
commit/push hooks remain enabled for PR handoff.

## References

- [Unresolved Sentry dashboard](https://zaksio.sentry.io/issues/?project=4511677909762048&query=is%3Aunresolved)
- [Delivery scheduler investigation](./delivery-scheduler.md)
- [Integration storage and delivery contract](../spec/contracts/storage-schemas-d1-integrations.md)
- [Control Panel observability contract](../spec/frontend/observability-pii-scrubbing.md)
- [D1 concurrency and throughput](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput)
- [Transactional D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [TanStack route onError callback](https://tanstack.com/router/latest/docs/api/router/RouteOptionsType#onerror-property)
