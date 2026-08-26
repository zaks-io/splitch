# Convex local evaluation uses nudge-pull sync and transactional Exposure delivery

**Status:** accepted

Convex queries and mutations cannot call third-party APIs. The current `@splitch/sdk` guidance
therefore evaluates in an Action before calling a mutation. That is usable for Flags, but it is the
wrong Experiment boundary: an Exposure can be sealed before the application mutation commits, and a
failed mutation can leave an Exposure for a Variant the Entity never encountered. The reference
LaunchDarkly Convex component solves local reads by syncing full server configuration, but explicitly
does not send evaluation events from queries.

## Decision

1. **Splitch ships `@splitch/convex` as a first-party Convex Component.** One component instance
   represents one Splitch Environment and holds an API Key in its private component environment.
   It stores a validated full configuration snapshot in component-owned tables and evaluates with
   the same extracted, runtime-neutral evaluator used by the Evaluation Worker.

2. **Configuration uses signed nudge then authenticated pull.** A committed Environment change
   creates a durable delivery row. Splitch sends a small `config.changed` webhook containing the
   monotonic Environment version, never Targeting Rules, salts, or Variant values. The component
   verifies the HMAC, records the announced version, and pulls the complete snapshot with its API
   Key. Duplicate and out-of-order deliveries are idempotent. The webhook is an accelerator, not a
   second configuration source.

3. **Queries are structurally non-exposing.** `peekVariant` and `peekDetails` may run in a Query or
   Mutation and never write. `evaluate` and `evaluateDetails` require a Mutation context. There is
   no Exposure-bearing query accessor and no boolean option that suppresses Exposure.

4. **The application's mutation commit is the encounter boundary.** An Exposure-bearing component
   mutation evaluates locally, establishes the local holdover, writes a retry-stable Exposure outbox
   row, and schedules delivery in the same top-level Convex transaction as the application's writes.
   If the top-level mutation rolls back, all component writes and the scheduled delivery roll back.
   The Exposure time is the Convex commit timestamp, not the later HTTP delivery time.

5. **Splitch verifies locally evaluated Exposures.** A new API-Key-only server Exposure endpoint
   loads the immutable Run, checks App/Environment/Flag/Experiment binding and `configHash`, and
   recomputes the Variant from the submitted Evaluation Context. A mismatched Variant or Run fails
   loud and seals nothing. The Exposure Ticket signing key is never distributed to Convex.

6. **`exposure_at` becomes the canonical encounter time.** Ordinary remote Evaluation stamps it
   with the Evaluation Worker's receive time. The Convex endpoint accepts the component's bounded
   commit timestamp after successful recomputation. `server_received_at` remains the Splitch receipt
   timestamp and `ingest_ts` remains the Tinybird insertion watermark. First-touch and Conversion
   Window ordering use `exposure_at`.

7. **Local reads consume zero Evaluations.** This follows ADR-0033's existing cached/local rule.
   Configuration sync and Exposure delivery are not billable Evaluation calls.

## Considered options

- **Evaluate in an Action, then mutate** was rejected as the final integration because mutation
  failure can create a false Exposure and every call pays a network round trip.
- **Fire Exposure from a query** was rejected because reactive queries may rerun without a new
  encounter and cannot durably write the event.
- **Trust raw client-reported Variant claims** was rejected because it allows drift or tampering to
  corrupt the Experiment denominator. The server recomputes against the immutable Run.
- **Give the component the Exposure Ticket HMAC key** was rejected because it would let a customer
  deployment mint arbitrary public-client tickets.
- **Push complete config in the webhook** was rejected because delivery retries and logs would carry
  sensitive server configuration, and the webhook would become a competing source of truth.
- **Use delivery receipt time as Exposure time** was rejected because an outage could place a Metric
  Event before the Exposure that caused it and silently corrupt the Conversion Window.

## Consequences

- The local component needs private configuration, holdover, integration-token, delivery-claim, and
  Exposure-outbox tables with bounded retention and deletion operations.
- Configuration and Exposure recovery use activity-driven scheduled Mutations that stop when their
  durable state is current. Retention uses one scheduled cleanup at the earliest known expiry and
  schedules its successor only while retained data remains. The component registers no cron jobs.
- Splitch needs an API-Key installation/config-snapshot surface, encrypted webhook-secret custody,
  a durable webhook delivery outbox, and a server Exposure endpoint.
- `raw_events` gains additive `exposure_at`; existing producers populate it from
  `server_received_at`, so old behavior is preserved while the trusted Convex source can retain the
  actual encounter time.
- Known staleness fails loud: after a newer version is announced, local evaluation cannot serve an
  older snapshot. With no newer announcement, the last validated snapshot remains usable as cached
  server configuration.

## Sources

- [Convex Components](https://docs.convex.dev/components/authoring)
- [Convex transaction composition](https://docs.convex.dev/components/using)
- [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)
- [Convex commit timestamps](https://docs.convex.dev/database/advanced/commit-timestamp)
- [LaunchDarkly Convex component](https://github.com/get-convex/launchdarkly)
- [ADR-0004](./0004-exposure-fires-on-read.md), [ADR-0005](./0005-exposure-dedup-first-touch-pipeline-authoritative.md),
  [ADR-0033](./0033-v1-billing-is-an-organization-scoped-evaluation-quota.md),
  [ADR-0048](./0048-precomputed-evaluations-decouple-resolution-from-exposure-via-exposure-tickets.md)
