# Delivery scheduler and D1 load

## Current operation

Convex configuration nudges and Cloudflare configuration pushes run on a delivery coordinator
for each App and Environment. D1 remains the transactional outbox and source of delivery state.
Successful mutating Control Plane requests wake due Environments in the resolved App;
installation registration and Convex secret rotation wake their credential-bound Environment.
The minute cron recovers dropped wakes by waking due Environments. Its `scheduledDueWork` probe
batches due-job checks, due delivery scopes, and both providers' lag rows in one D1 call. The
coordinator path uses 11 statements; idle ticks start no gated jobs. A failed or incomplete probe
reports a fault and falls back to standalone reads and ungated work. Sentry keeps its separate
Organization-scoped cursor and minute dispatch.

Every Wrangler environment selects `INTEGRATION_DELIVERY_MODE=coordinator`. The global cron
dispatcher remains available as a rollback mode. Both modes share D1 leases that exclude concurrent
claims of an unexpired leased row. Delivery remains at-least-once. Convex nudges contain only an
Environment version, and duplicate or out-of-order nudges are idempotent.

A terminal Convex response suppresses older pending versions and expired older leases, just as a
successful acknowledgment does. Invalid installation secrets defer Convex preparation for 30
minutes; scoped secret rotation clears that delay. These controls keep failed installations from
repeatedly consuming claim slots with historical versions.

See [ADR-0061](../adr/0061-integration-delivery-runs-on-a-per-environment-coordinator.md) for the
coordination decision and the [integration storage contract](../spec/contracts/storage-schemas-d1-integrations.md)
for claim ordering, leases and renewal, retry policy, subrequest accounting, snapshot caching,
alarm scheduling, and lifecycle generation checks. Those mechanics are specified there.

## Delivery lag and faults

The objective is that a healthy installation receives each committed Environment version within
10 seconds at p99 and 60 seconds worst case. These are objectives, not established production
latencies. The minute cron emits `integration-delivery-lag` per provider, App, and Environment
with healthy outstanding work. It includes `oldestAgeMs` and `healthyInstallationsWaiting`;
multiple outstanding versions count as one waiting installation.

Healthy means active with no `latest_delivery_error_json`. Convex also requires its preparation
cooldown to have expired. Retry schedules and unexpired leases do not hide outstanding work.
The daily 08:00 UTC cron does not run this lag check.

| Event or fault                           | Operator meaning                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `integration_delivery_lagging`           | Oldest healthy outstanding delivery is strictly older than 5 minutes.   |
| `integration_delivery_lag_read_failed`   | One provider's lag read failed; dispatch and the other report continue. |
| `integration_delivery_wake_failed`       | A request or registration could not wake a coordinator.                 |
| `integration_delivery_sweep_failed`      | The minute recovery sweep failed.                                       |
| `integration_delivery_run_failed`        | A coordinator run failed and schedules another attempt in 30 seconds.   |
| `convex_deployment_dormancy_failed`      | Recording a detected deleted deployment failed.                         |
| `convex_deployment_reprobe_failed`       | The daily dormant-deployment recovery job failed.                       |
| `delivery_retention_batch_limit_reached` | At least one provider exhausted its daily pruning budget.               |
| `delivery_retention_failed`              | Delivery pruning failed.                                                |

Coordinator runs emit `integration-delivery-run` with scope, provider claim and outcome counts,
duration, counted subrequests, and next wake. A received-2xx count records the receiver response;
it does not prove that the D1 acknowledgment committed. Compare these events with outstanding
age and D1 contention when diagnosing delivery delays.

## Dormant Convex installations

After an owned terminal callback `404`, the dispatcher probes the deployment separately. Only
an exact `<deployment>.convex.site` hostname is eligible. The probe requests
`https://<deployment>.convex.cloud/version`, with a five-second timeout and no redirects. A `404`
with a `convex-usher` header proves deletion; `200` means live. Other responses, custom domains,
and network failures are inconclusive and never prove deletion.

A confirmed deletion marks the active installation dormant without revoking or deleting it.
The same transaction suppresses its pending and leased deliveries. Configuration changes create
no new delivery rows for a dormant installation. A stale probe cannot override newer registration,
delivery, rotation, or recovery activity because the writes check a lifecycle generation.

The daily 08:00 UTC job re-probes at most 100 active dormant installations, oldest checked first,
with concurrency six. It reads the current callback and lifecycle generation when starting each
check. A live result reactivates the installation and requeues the current Environment version
atomically. Deleted or inconclusive results leave it dormant. Revoked installations cannot
reactivate through this process.

An exact re-registration with `callbackVerification: "hmac-sha256"` must prove control of the
receiver before clearing dormancy and requeuing the current version. Failed verification leaves
dormancy intact. An exact legacy `*.convex.site` re-registration without that capability returns
`200`, leaves the installation dormant and sends no challenge. Its response omits
`deploymentMissingAt` because those components parse the registration response strictly. Custom-domain registration
without receiver verification is rejected before registration state is read. Re-registration
preserves revoked status and rejects changed callback or secret content for the same installation.

## Deliver now

An App admin with the credentials grant can call:

```http
POST /apps/{appId}/envs/{environmentId}/integrations/deliveries
```

The operation wakes only that Environment and returns `wake: "scheduled"`. It does not wait for
receivers. The response includes each provider's pending count, leased count, and oldest
outstanding age. In cron mode it returns `wake: "cron_noop"` and the same summary without waking
or dispatching. A rejected coordinator wake reports `integration_delivery_wake_failed` with App,
Environment, and request scope, then returns `503 SERVICE_UNAVAILABLE` with `retryAfterMs: 30000`.
The operation does not reactivate dormant installations or rearm terminal deliveries.

## Retention and pruning counts

The daily 08:00 UTC job prunes at most 1,000 completed rows per provider strictly older than
30 days. Pending and leased rows never expire through this job. A saturated budget emits
`delivery-retention-batch-limit-reached` and `delivery_retention_batch_limit_reached`; history
can remain beyond 30 days while the backlog awaits capacity adjustment.

Use count-only queries to inspect eligibility before an approved pruning change:

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

Bind the intended scheduled run time minus 30 days. Production changes and permanent deletion
require explicit approval. Repair installation secrets through the owning installation's
authenticated rotation operation and matching receiver update; do not replace the shared KEK or
patch ciphertext as a shortcut.

## Mode rollback

With explicit production approval, set production `INTEGRATION_DELIVERY_MODE` to `cron` and deploy
the configuration change. This restores global minute dispatch and immediate App-scoped
Cloudflare dispatch. Existing coordinator alarms send nothing while cron mode is selected.
The shared leases exclude concurrent claims while unexpired, but cannot guarantee exactly-once
sending: a cron Cloudflare request has no timeout and can outlive its lease.

Compare healthy delivery latency, outstanding age, provider outcome logs, and D1 contention
after either mode change. Keep the cron dispatcher available until a separate removal decision.

## Local workerd load test

Run on demand, outside CI:

```sh
pnpm --filter @splitch/control-plane-api exec vitest run --config vitest.config.delivery-load.ts --maxWorkers=1
```

The three-minute workload uses real local workerd alarms, migrated D1, encrypted installation
secrets, config-version triggers, claims, and acknowledgments. Only outbound receivers are faked.
Environment A has 1,000 Convex installations split between HTTP `404` and `500`, with a config
change every ten seconds. Receiver latencies span 100 ms to 5.2 seconds, including requests that
exceed the real five-second abort deadline. Environment B has five HTTP-200 installations,
30 ms receiver latency, and a config change every two seconds. Every Environment B delivery,
including intermediate versions, must complete before results are recorded.

The latest recorded run, October 25 after main integration and the round-3 fixes, measured
180,004 ms of workload. All 450 Environment B deliveries completed: p50 534 ms, p99 706 ms,
maximum 708 ms. Environment A attempted 138 deliveries, or 0.77 attempts per second.
Deletion probes were included in the workload but excluded from delivery throughput.
Latency is `delivered_at - created_at`; trigger commit times have one-second precision.
The healthy Environment met the p99 ten-second objective locally. These results do not establish
production D1 latency or capacity.

## History

### October 5, 2026: D1 amplification review

The [SPL-690 review](https://linear.app/zaks-io/issue/SPL-690/reduce-delivery-scheduler-d1-query-amplification)
found a 15.36 MB production database with 22,956 read queries and 41,384 write queries in the
preceding day. A scheduler trace took 11.2 seconds, while the highest-volume SQL shapes averaged
sub-millisecond execution. Binding latency included network and queue time. Two installations
owned 298 pending Convex rows with repeated preparation failures; 16,330 rows were terminal after
HTTP `404`. Delivery retention was absent. Idle Sentry cursor reads also amplified rows read.

The claim fix reduced a 25-row claim from 51 D1 calls and statements to one transactional call
with two statements. An isolated non-production HTTPS proof recorded 25 signature-verified
receipts for each provider and excluded competing claims of leased rows. Independent completion
transactions preserved isolation between healthy and failing deliveries. Follow-up work added
newest-only Convex claims, preparation cooldowns, App-scoped Cloudflare dispatch, and bounded
30-day retention. The old "Pending release" checklist and recommendation to add a coordinator
are superseded by the shipped code and October 25 rollout.

### October 25, 2026: deleted previews starved Production

Neuron's Production installation waited 20 minutes behind Dev work. Of 437 active Dev
installations, 405 last returned `404` after preview deletion. Each terminal newest version
exposed an older pending version ahead of Production. Twenty ticks produced 496 terminal
responses and no Production attempt, with 1,614 older Dev rows still ahead. An approved one-row
schedule change let Production's newest version deliver and suppress its four older versions.

The fixes made terminal Convex outcomes suppress older work and changed claim fairness.
Per-Environment coordination then isolated executor time and claim slots, and dormancy stopped
new work for confirmed deleted deployments. The binding and indexes shipped in cron mode on
October 25 in #755; production switched to coordinator mode with explicit approval that day.
That approval skipped the planned shared-preview check. The local load result above is separate
from production evidence. D1 remains shared across Environments.
