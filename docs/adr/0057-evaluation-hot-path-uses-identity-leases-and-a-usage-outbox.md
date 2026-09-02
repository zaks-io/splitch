# Evaluation hot path uses reset-safe identity leases and the Evaluation commit outbox

**Status:** accepted

## Context

Hosted Evaluation reads the authoritative App identity from the App-scoped Config Store Durable
Object. An `evaluate-all` request admitted the generation, re-read it around resolution and billing,
then synchronously waited for Evaluation usage replay, aggregate admission, and Cloudflare Queue
handoff. Unlike single-Flag Evaluation, `evaluate-all` did not use the existing Evaluation commit
outbox. The correctness checks were individually valid, but serial cross-location calls made an
otherwise edge-local read take seconds.

App identity cannot become a Workers KV read model. A compromised-key reset must prevent a request
from returning work admitted under an identity generation that the reset destroys. Evaluation usage
also cannot become fire-and-forget: a successful response must have durable billing ownership, and
an exact retry must not consume new admission or Queue capacity.

## Decision

1. The Config Store authority issues a 10-second lease with an App identity read. Hosted data-plane
   stores may reuse that record until the lease expires. The authority persists the latest lease
   expiry. A destructive reset enters its existing `blockConcurrencyWhile` section, admits no new
   leases, waits for the persisted lease deadline, and only then begins the reset workflow. The
   request's existing final generation validation remains in place.

2. Non-cached `evaluate-all` usage uses the existing Evaluation commit endpoint with an empty
   Exposure set. Its established outbox owns the canonical usage row before returning acceptance,
   retries Queue publication, and participates in the App identity reset inventory. The cached
   telemetry path remains on the replay-window endpoint because it is non-billable and already runs
   outside the page-rendering request.

3. The Evaluation commit outbox remains the idempotency decision. Exact retries return its Event ID
   without a second admission charge or Queue handoff.

4. Independent per-Flag work in `evaluate-all` runs concurrently. The request-scoped Assignment
   Store promise remains memoized, so Experiment-backed Flags still perform one holdover read.

## Consequences

- Normal Evaluation work performs one authoritative identity read per lease instead of repeating the
  same remote read throughout a request.
- A compromised-key reset can wait up to 10 seconds before purge begins. It cannot race or invalidate
  a lease early, and blocked/reset identity records are never silently replaced with cached active
  data.
- Rolling the Control Plane back to a version without lease-aware reset requires a 10-second drain
  before invoking an App identity reset. Forward rollout is compatible because a new data-plane
  Worker requests a lease through the existing `readAppIdentity` RPC. An older authority ignores
  the optional request and returns the legacy scalar response, which the caller uses once without
  caching.
- Evaluation usage admission remains fail-closed and precedes durable acceptance. A sealed usage row
  survives Worker failure and Queue outage without requiring the SDK caller to retry.
- `202` still means durable Event Ingest ownership, not Tinybird delivery.

## Sources

- [ADR-0043](./0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md)
- [ADR-0044](./0044-entity-pseudonyms-remain-stable-under-routine-key-rotation.md)
- [ADR-0048](./0048-precomputed-evaluations-decouple-resolution-from-exposure-via-exposure-tickets.md)
- [Cloudflare Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
