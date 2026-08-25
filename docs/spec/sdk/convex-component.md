# Convex Component: synced local Flag evaluation

`@splitch/convex` is the first-party Convex Component for reading Splitch Flags inside Convex
queries and mutations without request-time HTTP. One component instance is bound to exactly one
Splitch Environment. It uses the same evaluator and contracts as the Evaluation Worker, not a
Convex-specific copy.

## Package and installation

The released package exposes:

- `@splitch/convex/convex.config.js`, installed with `app.use(splitch, { httpPrefix })`
- `@splitch/convex`, an ergonomic `Splitch` wrapper over the generated Component API

It versions independently from `@splitch/sdk`, starts at `0.1.0`, and uses `convex-v*` GitHub
Releases. Token-free trusted package release runs from dedicated `convex-release` and
`convex-publish` workflows. Candidate validation installs the packed tarball into a clean Convex
fixture, typechecks the mounted component API, imports the runtime package, and rejects
workspace-only dependency leakage. Component codegen remains a live-deployment verification step.

The component declares one required secret environment value, `SPLITCH_API_KEY`. It obtains the
mounted callback URL from `CONVEX_SITE_URL`. `install()` generates and privately stores the
installation ID and webhook secret, registers them through the API-Key-only
[Convex integration API](./convex-integration-api.md), and performs the first full sync. Missing or
malformed credentials fail before any integration or config row is written.

Each additional Splitch Environment uses another named component instance, API Key, HTTP prefix,
configuration store, local Assignment Store, and outbox. No instance can read another instance's
tables or credential.

## Configuration snapshot

`GET /api/integrations/convex/snapshot` requires an API Key and returns the complete, server-only Provider
snapshot for that credential's App and Environment:

```text
ConfigSnapshot {
  schemaVersion
  environmentVersion
  appId
  environmentId
  flags[]             // resolved Flag Configuration and Variant values
  experiments[]       // targeting key field/type and nullable liveRunId
  runs[]              // immutable live Run config including configHash
}
```

The request cannot select App or Environment. The credential is the authority. The response is
strictly validated before one mutation atomically replaces the prior snapshot. Unknown schema
versions, missing references, duplicate keys, mismatched scope, or a version below the announced
minimum fail loud and leave the last validated snapshot unchanged. Snapshot sync consumes zero
Evaluations.

The runtime-neutral evaluator is extracted from the Evaluation Worker and owns Condition matching,
Fractional Evaluation, rule ordering, Resolution Details, and live-Run Assignment. Shared golden
vectors must prove the Worker and component return the same result for the same snapshot and
Evaluation Context.

## Signed webhook nudge

Successful installation creates one active integration. The component generates the HMAC secret;
Splitch accepts it only in the redacted installation request and stores it encrypted under the
configured webhook key-encryption key. Rotation uses the two-secret handoff in
[convex-integration-api.md](./convex-integration-api.md#secret-rotation); neither side reads a stored
plaintext value.

Every committed Environment config change atomically creates a durable webhook delivery:

```text
ConfigChanged {
  deliveryId
  type: "config.changed"
  appId
  environmentId
  environmentVersion
  changed: { entity, id }
}
```

The request carries `Splitch-Signature` over the exact body plus a bounded timestamp. The component
rejects an invalid signature, wrong App/Environment, expired timestamp, or reused `deliveryId`
before scheduling work. A valid nudge first raises the stored `announcedVersion`, then atomically
schedules an immediate sync Action and returns `202`. Duplicate or older versions return `202`
without another pull.

D1 triggers insert the webhook outbox in the same transaction as the authoritative Flag Configuration
commit and increment the Environment configuration version. A lease scanner dispatches immediately
due rows every minute and retries with bounded exponential backoff. Delivery failure never rolls back
durable config and is visible on the integration status surface.

## Evaluation surface

```ts
splitch.peekVariant(ctx, flagKey, context, defaultValue);
splitch.peekDetails(ctx, flagKey, context, defaultValue);
splitch.evaluate(ctx, flagKey, context, defaultValue);
splitch.evaluateDetails(ctx, flagKey, context, defaultValue);
```

`peekVariant` and `peekDetails` accept Query or Mutation context and are structurally non-exposing.
`evaluate` and `evaluateDetails` accept Mutation context only and require a caller-stable
`idempotencyKey` in the Evaluation Context. Their result shapes and fail-loud behavior match
`@splitch/sdk`; there is no `sendExposure` option.

If no fresh live-Run Assignment occurs, `evaluate` writes no Exposure. For a fresh Assignment it
atomically creates the local holdover and Exposure outbox row described in
[convex-exposure-delivery.md](./convex-exposure-delivery.md). A query that needs an Exposure must
perform an explicit mutation when the Variant is actually encountered, or use the browser SDK's
Exposure Ticket flow.

## Local holdover and freshness

The component's private Assignment Store keys by
`(experimentId, idType, HMAC(componentIdentityKey, idType + ":" + targetingKey))` and stores only
the original `runId` and Variant name. The raw Targeting Key is absent. A fresh Exposure and its
holdover commit together; concurrent first use is serialized by the Convex transaction. Later Runs
replay the held Variant and create no new Exposure.

No installed snapshot, invalid stored data, or `snapshot.environmentVersion < announcedVersion`
returns `reason: ERROR` with an actionable code. If no newer version has been announced, the last
validated snapshot remains usable with local/cached diagnostics. A sync Action never replaces good
state with a partial or older snapshot.

## Deletion and uninstall

The package exposes bounded mutations for deleting one Entity's local holdovers and pending outbox
rows and for uninstalling an instance. The Entity mutation derives the component-local
`targetingKeyHash` from `idType` and the supplied Targeting Key, suppresses only matching rows before
purge, and makes every already scheduled delivery recheck suppression before sending. Uninstall
revokes the Splitch integration, stops new delivery, and batch-purges config, tokens, claims,
holdovers, and outbox rows. App deletion sends a terminal signed nudge before credential revocation
so the component can perform the same purge.

## Non-goals

- Browser or mobile configuration sync. Public clients continue to receive resolved values, never
  Targeting Rules or assignment salts.
- A generic webhook framework or a second configuration source. The signed callback is only a nudge
  to pull the authoritative snapshot.
- An OpenFeature Provider surface in V1. The component exposes the four explicit Splitch accessors.
- Supporting arbitrary local-evaluation adapters before a second real adapter exists.

## Done

- A packed package installs into a clean Convex fixture and passes mounted-component typecheck;
  component codegen passes against a live preview deployment.
- Package tests prove query peeks do not write, mutation Evaluation rolls back with the caller,
  duplicate mutation retries do not duplicate Exposures, and concurrent first use creates one local
  holdover.
- A live preview journey changes a Flag, receives the signed nudge, syncs at least the announced
  version, and changes a query result without a request-time Splitch call.
- Failure tests cover forged/replayed webhooks, known-stale config, malformed snapshots, unavailable
  Splitch, cross-instance scope, deletion, and uninstall.

## Sources

- [ADR-0049](../../adr/0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)
- [Convex component authoring](https://docs.convex.dev/components/authoring)
- [Convex component transactions](https://docs.convex.dev/components/using)
- [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)
- [provider-port.md](../evaluation/provider-port.md), [exposure-accessor.md](./exposure-accessor.md)
