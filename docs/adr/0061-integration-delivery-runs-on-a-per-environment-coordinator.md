# Integration delivery runs on a per-Environment coordinator

**Status:** accepted

Convex webhooks and Cloudflare pushes for every Environment used to share one global outbox scan
on the minute cron, 25 rows per tick. On 2026-10-25, about 405 deleted Dev preview installations
held one App's Production deliveries for over 20 minutes. Ordering the shared queue so failing
installations go last (#753) cannot stop a large healthy fan-out in one Environment from delaying
another, retries still waited for the next tick, and Convex had no dispatch after commit.

## Decision

Each `(App, Environment)` has its own delivery coordinator, `IntegrationDeliveryDurableObject`,
named `${appId}:${environmentId}`. It alone sends that Environment's Convex webhooks and Cloudflare
pushes.

- **D1 stays the source of truth.** Config triggers keep inserting outbox rows in the config
  transaction. The coordinator stores no delivery state; its only state is its alarm.
- **Environment-scoped claims.** A coordinator claims due rows for its own Environment with the
  existing claim ordering, leases, suppression, and retry ladder. It never reads another
  Environment's rows.
- **Alarm-driven.** `wake()` sets the alarm to now unless one is already due sooner. The alarm
  claims and sends with one claim and at most six requests in flight, repeats until nothing is due
  or 60 seconds have passed, then sets the alarm to the Environment's earliest future retry, lease
  expiry, or preparation cooldown, never later than an alarm set during the run. The handler
  catches its own failures, reports them, and reschedules in 30 seconds instead of relying on the
  platform's capped alarm retries.
- **Wake sources.** A successful mutating Control Plane request wakes each coordinator in the
  resolved App that has due work. Installation registration and secret rotation wake their
  Environment. The minute cron becomes a sweep: it wakes every Environment with due work and sends
  nothing itself, so the sweep cannot be monopolized.
- **Mode switch.** `INTEGRATION_DELIVERY_MODE` is `coordinator` or `cron` and is required in every
  Wrangler environment. `cron` restores the global dispatcher and the App-scoped immediate
  Cloudflare dispatch. Both modes share D1 leases, which exclude concurrent claims of an unexpired
  leased row. Delivery remains at-least-once, including across a mode switch. Duplicate Convex
  nudges are harmless because they carry only a version and the component version-gates sync
  ([ADR-0049](./0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)).
- **Delivery-lag objective.** A healthy installation receives each committed version within 10
  seconds at p99 and 60 seconds at worst, whatever happens in other Environments. The minute job
  reports a fault when a healthy installation's oldest outstanding delivery is older than 5
  minutes.

Sentry delivery is Organization-scoped with its own cursor and is unchanged.

## Considered options

- **Per-Environment quotas in the global cron.** Rejected. It is still one executor per minute,
  retries still wait for the tick, and one Environment's volume still spends the shared budget.
- **Cloudflare Queues.** Rejected as the isolation mechanism. Queues are static resources, not one
  per Environment, and D1 triggers cannot enqueue, so the outbox and a scan remain. One shared queue
  brings back head-of-line blocking.
- **Delivering from `ConfigStoreDurableObject`.** Rejected. It serializes config writes and serves
  live-update WebSockets; outbound HTTP to hundreds of receivers should not share that isolate, and
  delivery needs its own switch.
- **An outbox table or D1 database per Environment.** Rejected. The trigger must insert in the
  config transaction, and sharding D1 adds capacity, not executor isolation.

## Consequences

- Every Wrangler environment gains the `INTEGRATION_DELIVERY` Durable Object binding.
- D1 stays shared and executes serially. Each coordinator bounds its own load, but dead receivers
  in one Environment still cost D1 writes, so deleted Convex deployments are handled separately.
- "Dispatch starts immediately after commit" becomes true for Convex.
- The global dispatcher is deleted one release after production runs in `coordinator` mode.
