# Convex Metric Event boundary

`@splitch/convex` does not transport Metric Events. Metric Events are high-volume analytics data,
not application state, and go directly from `@splitch/sdk` to the Cloudflare Event Ingest API.

## Public contract

The component exposes no `track` or `trackStatus` method. A Convex Action or HTTP Action uses the
server SDK with a `data-plane:write` API Key:

```ts
await splitch.track("checkout_completed", {
  targetingKey,
  idType: "user",
  eventId,
  fields: { revenue },
  dimensions: { plan },
});
```

When the same product fact is the frozen Activation Metric, use `activate`
instead of issuing separate Metric Event and Activation calls:

```ts
await splitch.activate("checkout_completed", {
  targetingKey,
  idType: "user",
  eventId,
  fields: { revenue },
  dimensions: { plan },
});
```

The Activation API derives matching live Experiment Runs from published
configuration and durably claims the Metric Event and Activation rows together.
The application never supplies Experiment, Run, or Variant identity.

The caller owns one lowercase UUID per logical Metric Event and reuses it for retries. The Event
Ingest API remains authoritative for Event Definition validation, idempotency, queue recovery,
Tinybird persistence, and terminal delivery diagnostics.

## Storage boundary

No new Metric Event creates a component table row, claim, scheduled function, Action, or copy of its
Targeting Key, fields, or Dimensions. The component snapshot contains only current Flag and
Experiment configuration. Tinybird is the authoritative Metric Event history.

Legacy `metricEventClaims` and `metricEventOutbox` tables remain migration-only while already queued
rows are delivered or terminalized. Their functions are internal, and the generated component API
does not expose a path that creates new rows. A later schema-removal release may delete those tables
after upgrade fixtures prove every legacy row is accounted for.

## Transaction tradeoff

Direct SDK delivery is not atomic with an unrelated Convex Mutation. Callers that require a durable
business fact should make that fact idempotent, then invoke the SDK from an Action or HTTP Action
using the same logical `eventId`. Splitch's Cloudflare ingestion claim is the retry boundary. The
component does not recreate a transactional analytics outbox because doing so puts every Metric
Event back through Convex storage and scheduled functions.

## Done

- Packed consumer types contain no `track`, `trackStatus`, or public Metric Event component API.
- Installing the component requires only `data-plane:evaluate`.
- New Metric Events create no Convex rows or scheduled functions.
- Legacy delivery remains internal and finite until a separately verified schema-removal release.
- Direct SDK Metric Events retain Event Ingest idempotency, Queue recovery, and Tinybird visibility.

## Sources

- [Metric Event contract](../pipeline/metric-event-contract.md)
- [Convex Component](./convex-component.md)
- [Convex Exposure delivery](./convex-exposure-delivery.md)
