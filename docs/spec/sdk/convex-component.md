# Convex Component: synced local Flag evaluation

`@splitch/convex` is the first-party Convex Component for reading Splitch Flags inside Convex
queries and mutations without request-time HTTP. One component instance is bound to exactly one
Splitch Environment. It uses the same evaluator and contracts as the Evaluation Worker, not a
Convex-specific copy.

## Package and installation

The released package exposes:

- `@splitch/convex/convex.config.js`, installed with `app.use(splitch, { httpPrefix })`
- `@splitch/convex`, an ergonomic `Splitch` wrapper over the generated Component API
- `@splitch/convex/react`, reactive hooks bound to an app-owned public Query

It versions independently from `@splitch/sdk`, starts at `0.1.0`, and uses `convex-v*` GitHub
Releases. Token-free trusted package release runs from dedicated `convex-release` and
`convex-publish` workflows. Candidate validation installs the packed tarball into a clean Convex
fixture, typechecks the mounted component API, imports the runtime package, and rejects
workspace-only dependency leakage. Component codegen remains a live-deployment verification step.

The package depends on `@splitch/sdk` for its public evaluation types and the
`@splitch/sdk/local-evaluation` evaluator interface. Private contracts and evaluation-core modules
never appear in the published Convex dependency graph.

The component declares one required secret environment value, `SPLITCH_API_KEY`. It derives the
mounted callback URL from both Convex automatic URLs: the canonical `CONVEX_CLOUD_URL` supplies the
Convex-owned deployment name and `CONVEX_SITE_URL` supplies the component mount path. It converts
only the canonical `*.convex.cloud` origin to `*.convex.site`. Custom HTTP Action domains therefore
never widen the Control Plane callback allowlist. `install()` generates
and privately stores the installation ID and webhook secret, registers them through the API-Key-only
[Convex integration API](./convex-integration-api.md), and performs the first full sync. Missing or
malformed credentials fail before any integration or config row is written. That Key needs only
`data-plane:evaluate`; Metric Events go directly through `@splitch/sdk` with a separately scoped
write credential.

An installation left pending by the former custom-domain callback behavior repairs that local
callback on the next `install()` call before retrying registration. An already canonical pending
installation retains its original content so an ambiguous remote outcome remains exactly retry-safe.

`install()` is an exact-retry-safe upgrade entrypoint as well as the initial installation call.
After a package upgrade, rerunning it resumes stale configuration sync, schedules retention for
existing retained rows, and activates one bounded adoption chain for pending or delivering work
created by the prior component version.

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
schedules an immediate sync Action and one version-scoped recovery Mutation. The recovery Mutation
keeps scheduling the Action once per minute only while the stored snapshot remains behind that
announced version, and cancels its next run when a current snapshot commits. Duplicate or older
versions return `202` without another pull.

There is no reconciliation cron. Configuration recovery and one installation-scoped Exposure batch
successor are created atomically with the durable work they protect. The drainer claims up to 25
Exposures within the 32 KiB request bound and settles the batch in one Mutation. Retained claims and
terminal Exposure rows share one scheduled cleanup Mutation set for the earliest expiry; it
schedules its successor only while retained data remains. Activation separately seeds
version-scoped recovery when configuration is stale.

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

Evaluation parses the current snapshot first, identifies the Flag's live Experiment, and reads at
most that one `(idType, targetingKeyHash, experimentId)` Assignment. It never scans the Entity's
Assignment history.

If no fresh live-Run Assignment occurs, `evaluate` writes no Exposure. For a fresh Assignment it
atomically creates the local holdover and Exposure outbox row described in
[convex-exposure-delivery.md](./convex-exposure-delivery.md). A query that needs an Exposure must
perform an explicit mutation when the Variant is actually encountered, or use the browser SDK's
Exposure Ticket flow.

## Metric Events

`@splitch/convex` exposes no `track` or `trackStatus` API. Metric Events are analytics transport, not
application state, and go directly from `@splitch/sdk` to the Cloudflare Event Ingest API. The
component retains migration-only delivery functions until legacy rows are drained; no new Metric
Event row can enter through the component's public API. See
[convex-metric-event-delivery.md](./convex-metric-event-delivery.md).

## React bindings

`createSplitchReact(api.flags.resolve)` binds `useFlag` and `useFlagDetails` to an app-owned public
Query. The app Query is the authentication boundary and calls `peekDetails` with an Evaluation
Context derived server-side. Component functions and the API Key remain private. The hooks use the
native Convex React subscription and return `undefined` while the first Query result is loading.

React hooks are non-exposing because Convex Queries cannot write. An app records an Exposure through
an explicit Mutation that calls `evaluate` when the Variant is encountered. Domain writes and their
Exposure stay in that same Mutation so they commit or roll back together.

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
- An OpenFeature Provider surface in V1. The component exposes explicit Splitch accessors.
- Supporting arbitrary local-evaluation adapters before a second real adapter exists.

## Done

- A packed package installs into a clean Convex fixture and passes mounted-component typecheck;
  its React export typechecks from the packed tarball; component codegen passes against a live
  preview deployment.
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
