# Convex Metric Event delivery

`@splitch/convex` provides mutation-native, durable Metric Event tracking. Application state and the
intent to deliver its Metric Event commit or roll back in one Convex transaction. Network delivery
happens only after that transaction commits.

## Public contract

```ts
type ConvexMetricEvent = Omit<TrackRequest, "eventName">;

track(
  ctx: GenericMutationCtx,
  eventName: string,
  event: ConvexMetricEvent,
): Promise<{ eventId: string; queued: true }>;

trackStatus(
  ctx: GenericQueryCtx | GenericMutationCtx,
  eventId: string,
): Promise<{
  eventId: string;
  state: "missing" | "queued" | "accepted" | "terminal" | "suppressed";
  error?: string;
}>;
```

The caller creates one lowercase UUID for each logical Metric Event and stores it with the
application fact. An exact retry returns the existing queued receipt. Reusing that UUID for
different content fails with `EVENT_ID_CONFLICT`.

`queued: true` means the delivery intent joined the caller's transaction. It does not mean that the
Event Ingest API accepted the Event Definition or payload. The component snapshot intentionally
contains no Event Definitions, so semantic validation stays authoritative at `/api/sdk/events`.

## Transaction and identity

The Mutation validates the SDK wire shape and 32 KiB body limit before writing. It derives the
component-local Targeting Key HMAC and fingerprints
`{ eventName, idType, targetingKeyHash, fields, dimensions }`. The retained idempotency claim never
contains the raw Targeting Key or a plain hash of it.

The Mutation then writes the claim and outbox row and schedules both immediate delivery and a
lease-recovery watch. Convex commits or rolls back those operations with the caller's top-level
Mutation. Calling `track()` from an Action directly is not the durable seam; the Action must call a
Mutation that persists both the application fact and Metric Event intent.

## Delivery

The scheduled Action claims one row under a one-minute lease and posts the unchanged SDK request to
`/api/sdk/events` with the installed API Key. A valid accepted response moves the claim to
`accepted` and deletes the raw outbox row.

Network errors, malformed success responses, HTTP 408, HTTP 429, and HTTP 5xx retry the same row and
`eventId` after 1 second, 5 seconds, 30 seconds, 2 minutes, 10 minutes, then 30 minutes, with up to
20 percent deterministic jitter. The recovery watch restarts a missed Action or expired lease.

Other HTTP 4xx responses are terminal. The claim retains the allowlisted error code and message so
`trackStatus()` is actionable, while the raw Targeting Key, fields, and Dimensions are deleted. A
terminal transition also writes a loud, payload-free Convex log.

Raw delivery data has a 24-hour deadline. An event still undelivered at that deadline becomes
terminal and loses its raw payload. Completed claims remain for 30 days so exact retry and status
semantics survive delivery. Metric Events continue to use Splitch's server receipt time; they do not
borrow the Convex commit timestamp used for Exposures.

## Deletion, uninstall, and upgrade

Entity deletion refuses to race an active delivery, then suppresses and deletes matching pending
rows before removing local Assignments. Component uninstall purges Metric Event rows and claims with
the rest of the private integration state. Upgrade recovery adopts pending and delivering Metric
Event rows alongside Exposure rows.

## Done

- A caller Mutation can persist application state and queue one Metric Event atomically.
- Exact retries preserve one delivery; conflicting retries fail loud.
- Tests cover structural rejection, terminal replay, deterministic rejection, malformed-success
  retry, expired-lease recovery, cleanup, and packed-consumer types.
- A preview journey proves application Mutation, `/api/sdk/events` acceptance, `accepted` status,
  Results visibility, retry deduplication, and cleanup.

## Sources

- [Metric Event contract](../pipeline/metric-event-contract.md)
- [Convex Component](./convex-component.md)
- [Convex Exposure delivery](./convex-exposure-delivery.md)
- [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)
