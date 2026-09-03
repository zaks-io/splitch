# Activation not available is coarse and non-retryable

**Status:** accepted

`activate()` resolves published Activation bindings and an Entity's Exposure-backed Assignment
before it writes a Metric Event or Activation row. Three valid request states cannot be repaired by
retrying the same request: no Run uses the Event Definition for Activation, no such Run targets the
request's Entity type, or the Entity has no Exposure in a matching Run. Returning
`503 SERVICE_UNAVAILABLE` with `Retry-After` for these states instructs SDKs and agents to retry a
permanent result. Returning a distinct result for each state would let a public Client Key use the
endpoint as an enrollment oracle.

## Decision

`POST /api/sdk/activations` returns `409 ACTIVATION_NOT_AVAILABLE` with empty details and no
`Retry-After` for the three permanent states. An API Key response may name the failed resolution
step in its message.

A Client Key receives one fixed `ACTIVATION_NOT_AVAILABLE` body for all non-activatable request
states. The public tier deliberately includes an unpublished Environment Activation configuration
in that same body, even though an initial publication can make it resolvable later. This keeps an
unpublished configuration indistinguishable from an Entity without a matching Exposure.

Infrastructure and integrity failures remain `503 SERVICE_UNAVAILABLE` with `Retry-After`. These
include unavailable configuration, Assignment, or source-identity infrastructure and conflicting
Assignment values that require operator repair. Server-side diagnostics retain the complete cause
and identifiers on both disclosure tiers.

## Considered options

- Keep `SERVICE_UNAVAILABLE` but omit `retryAfterMs` for permanent states. Rejected because a 503
  still means temporary unavailability and conflicts with the shared error contract.
- Keep every resolution failure retryable. Rejected because it directs callers to burn requests on
  a condition that cannot clear without a configuration, Exposure, or identity change.
- Expose detailed permanent codes to Client Keys. Rejected because the distinctions reveal whether
  an Event Definition participates in Activation and whether an Entity has a matching Exposure.

## Consequences

- Callers stop retrying the same request on `ACTIVATION_NOT_AVAILABLE`. They may submit a later
  request after the configuration or Entity state changes.
- A public caller can learn only that the request is not currently activatable, which success versus
  failure already reveals. It cannot identify which configuration or enrollment predicate failed.
- The new code is limited to `sdk_activate`; ordinary `track()` and Exposure redemption retry
  semantics do not change.

## Sources

- [Metric Event contract](../spec/pipeline/metric-event-contract.md)
- [Error response contract](../spec/contracts/error-responses.md)
- [Event Ingest resolution](../../apps/event-ingest-api/src/metric-event-activation.ts)
- [Disclosure boundary](../../apps/event-ingest-api/src/metric-event-ingest.ts)
