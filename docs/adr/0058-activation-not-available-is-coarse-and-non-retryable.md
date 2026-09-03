# Activation not available is coarse and non-retryable

**Status:** accepted; amended 2026-09-02

`activate()` resolves published Activation bindings and an Entity's Exposure-backed Assignment
before it writes a Metric Event or Activation row. Two valid request states cannot be repaired by
retrying the same request: no Run uses the Event Definition for Activation, and no such Run targets
the request's Entity type. Returning `503 SERVICE_UNAVAILABLE` with `Retry-After` for these states
instructs SDKs and agents to retry a permanent result. Returning a distinct result for each state
would let a public Client Key use the endpoint as an enrollment oracle.

The original decision counted a third state, an Entity with no Exposure in a matching Run, as
permanent. That was wrong. An SDK that drains Exposures asynchronously and in batches can deliver
an Activation for an Entity whose own Exposure is still in flight, so this state routinely clears
within a second without any configuration, Exposure, or identity change by the caller. It is the
one resolution failure a correct caller reaches on a correctly configured Experiment.

## Decision

`POST /api/sdk/activations` returns `409 ACTIVATION_NOT_AVAILABLE` with empty details and no
`Retry-After` for the two permanent states. An API Key response may name the failed resolution
step in its message.

For an API Key, a missing Exposure returns `503 SERVICE_UNAVAILABLE` with `retryAfterMs` and names
the condition. A trusted caller has to distinguish the racing state from the permanent ones to
avoid dropping the event, and prose in `message` is not a contract it can branch on.

A Client Key receives one fixed `ACTIVATION_NOT_AVAILABLE` body for all non-activatable request
states, the missing Exposure included. The public tier deliberately includes an unpublished
Environment Activation configuration in that same body, even though an initial publication can make
it resolvable later. This keeps an unpublished configuration indistinguishable from an Entity
without a matching Exposure. The API-Key 503 must not reach this tier: a status that fires exactly
when a named Entity has no Exposure is the enrollment oracle this ADR exists to prevent. The
infrastructure 503s below are public-safe because they do not depend on the Entity.

Infrastructure and integrity failures remain `503 SERVICE_UNAVAILABLE` with `Retry-After`. These
include unavailable configuration, Assignment, or source-identity infrastructure and conflicting
Assignment values that require operator repair. Server-side diagnostics retain the complete cause
and identifiers on both disclosure tiers.

## Considered options

- Keep `SERVICE_UNAVAILABLE` but omit `retryAfterMs` for permanent states. Rejected because a 503
  still means temporary unavailability and conflicts with the shared error contract.
- Keep every resolution failure retryable. Rejected because it directs callers to burn requests on
  a condition that cannot clear without a configuration, Exposure, or identity change. This still
  holds for the two permanent states.
- Keep the missing Exposure permanent and let trusted callers match on `message`. Rejected because
  it makes a retry decision depend on parsing English, and the two permanent causes and the racing
  one are otherwise byte-identical.
- Add `details.reason` to `ACTIVATION_NOT_AVAILABLE` instead of changing the status. Rejected
  because `ACTIVATION_NOT_AVAILABLE` is contracted with empty details, and the retry signal the
  caller needs already exists as `retryAfterMs` on 503.
- Expose detailed permanent codes to Client Keys. Rejected because the distinctions reveal whether
  an Event Definition participates in Activation and whether an Entity has a matching Exposure.

## Consequences

- Callers stop retrying the same request on `ACTIVATION_NOT_AVAILABLE`. They may submit a later
  request after the configuration or Entity state changes.
- An API Key caller retries a missing Exposure on the advertised delay and stops losing the first
  Activation of an Entity's life to its own in-flight Exposure. A genuinely unexposed Entity costs
  that caller a bounded number of retries before it gives up, which is the same drop as before, later.
- A public caller can learn only that the request is not currently activatable. The success or
  failure response already reveals that fact. It cannot identify which configuration or enrollment
  predicate failed.
- The new code is limited to `sdk_activate`; ordinary `track()` and Exposure redemption retry
  semantics do not change.

## Sources

- [Metric Event contract](../spec/pipeline/metric-event-contract.md)
- [Error response contract](../spec/contracts/error-responses.md)
- [Event Ingest resolution](../../apps/event-ingest-api/src/metric-event-activation.ts)
- [Disclosure boundary](../../apps/event-ingest-api/src/metric-event-ingest.ts)
