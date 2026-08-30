# Privacy Durable Objects exclude reset from delivery, not delivery from itself

**Status:** accepted

The App-identity inventory is one Durable Object per App, addressed
`idFromName(`${appId}:app-identity-inventory`)`, so every event an App sends passes through a single
object worldwide (`apps/event-ingest-api/src/entity-metric-privacy.ts:31`). That object wrapped
every request in an explicit promise-chain mutex, and `/deliver-entity-row` holds its turn across a
nested Durable Object hop and a Tinybird HTTP round trip
(`apps/event-ingest-api/src/app-identity-event-inventory.ts:97`). One App's entire ingest was
therefore capped at one event per Tinybird round trip, which is the throughput ceiling Cloudflare
describes for holding a Durable Object's concurrency across I/O: "If this takes ~5ms, you're
limited to ~200 requests/second."

The mutex was not gratuitous. Delivery and a privacy reset must not overlap: a reset that purged
while a delivery it had already admitted was mid-Tinybird would let a deleted row land after the
deletion proof was returned (ADR-0032).

## Decision

1. **Delivery and reset are a readers-writer section, not a mutex.** Per-row work (`/register`,
   `/register-evaluation`, `/suppressed`, `/register-app-entity`, `/register-app-evaluation`,
   `/deliver-app-row`, `/deliver-entity-row`, `/deliver-row`) takes the shared side and runs
   concurrently. Whole-inventory work (`/suppress`, `/delete`, `/reset-app`, `/complete-reset`,
   `GET /export`) takes the exclusive side. The lock lives in
   `apps/event-ingest-api/src/delivery-reset-lock.ts`.

2. **The exclusion the mutex provided is preserved exactly.** An exclusive section waits for every
   already-admitted shared section to finish before it runs, so a reset still cannot purge past a
   delivery that is mid-Tinybird. A shared section that has not yet been admitted waits for a
   pending exclusive one, so it reads the post-reset suppression state and `admitVersion` refuses
   it. There is no window in which a delivery reads pre-reset state and writes post-purge.

3. **Writers are preferred.** A writer claims the lock synchronously, before its first `await`, so
   deliveries arriving in the same turn already see it and yield. A busy App cannot starve a privacy
   reset, which is a deletion obligation with a deadline.

4. **Delivery does not need to exclude other deliveries, because input gates already cover the part
   that matters.** `admitVersion` and the inventory `put` that follows it are an unbroken chain of
   storage operations with no non-storage I/O between them
   (`apps/event-ingest-api/src/app-identity-event-inventory.ts:90-97`, `:178-189`). Cloudflare
   states that while storage operations execute "no other requests can interleave — input gate
   blocks new events." Concurrency only opens at the `fetch()` that follows, and by then the
   admission decision and its inventory record are already durable. Two deliveries interleaving
   there race over nothing: each carries its own row and its own dedup key.

5. **Every route names its side explicitly and an unlisted path is a 404.** A new route cannot
   inherit the weaker side by omission, which is the failure mode that would silently reopen the
   purge race (ADR-0036).

6. **Lock order is unchanged: App authority, then Entity authority.** The two levels use the same
   lock type and the order stays acyclic, so the added concurrency introduces no deadlock.

## Consequences

- One App's ingest is no longer serialized on Tinybird latency. Concurrent deliveries are in flight
  against Tinybird simultaneously, proved by
  `apps/event-ingest-api/src/app-identity-delivery-throughput.test.ts`.
- A privacy reset now waits for in-flight deliveries rather than for a mutex turn, so its latency is
  bounded by the slowest admitted delivery instead of by the queue ahead of it.
- The lock is in-memory per Durable Object instance, which is the same scope the mutex had. It
  coordinates requests to one object, not across objects; cross-object ordering remains the App to
  Entity lock order.
- A failed section releases the lock and the rejection reaches the caller, so a throwing reset
  cannot wedge an App's ingest shut.
- Tinybird's per-request ceiling is now the binding constraint on delivery instead of this lock.
  Batching rows into one request is separate work (ADR-0043, SPL-447).

## Sources

- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Objects: State](https://developers.cloudflare.com/durable-objects/api/state/)
- [Cloudflare glossary: input gate](https://developers.cloudflare.com/glossary/)
- [ADR-0032](./0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)
- [ADR-0036](./0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [ADR-0043](./0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md)
