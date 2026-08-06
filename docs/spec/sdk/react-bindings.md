# React bindings: provider + hooks over the browser client

The `@splitch/sdk/react` subpath ([browser-client.md](./browser-client.md), Packaging): a provider
and hooks over the static-context browser client. Components read Flags synchronously and re-render
only when a revalidation swap changes the Flag they read. The bindings add no evaluation, exposure,
or transport behavior of their own — every semantic rides the browser client unchanged; this doc
fixes only the React seam. OpenFeature's React SDK is the pattern reference for the surface shape;
it is not a dependency.

## Surface

```tsx
import { SplitchProvider, useFlag, useFlagDetails, useSplitchClient } from "@splitch/sdk/react";

<SplitchProvider client={splitch}>
  <App />
</SplitchProvider>;

function Checkout() {
  const enabled = useFlag("new-checkout", false); // sync exposing read
  const details = useFlagDetails("new-checkout", false); // full SdkResolutionDetails
  const client = useSplitchClient(); // escape hatch: flush(), close(), imperative reads
}
```

```ts
useFlag(flagKey: string, defaultValue: VariantValue): VariantValue
useFlagDetails(flagKey: string, defaultValue: VariantValue): SdkResolutionDetails
useSplitchClient(): SplitchBrowserClient
```

That is the entire surface. Hook names follow the OpenFeature React convention (`useFlag`, not
`useEvaluate`) because React hooks name the thing subscribed to, not the verb; the accessor
vocabulary is preserved one level down — `useFlag`/`useFlagDetails` delegate to
`evaluate`/`evaluateDetails`, **the exposing reads** (`packages/sdk/CONTEXT.md`). The
`defaultValue` parameter is the caller's Default Variant, same position and typing
(`VariantValue`) as the client accessors.

## Provider

`SplitchProvider` accepts one prop, `client`: a constructed `SplitchBrowserClient`. It **borrows**
the client — it never constructs one, never calls `init()`, and never calls `close()` on unmount.
The app owns the client lifecycle exactly as it does without React (construction performs no I/O;
`init()` or a bootstrap makes reads available; `close()` is the app's shutdown concern). A provider
that owned lifecycle would hide the `init()` await and reintroduce the un-renderable window the
fail-loud table exists to expose.

Standard context semantics: providers may nest, innermost wins. Changing user means constructing a
new client and passing it as the new `client` prop (static-context paradigm — no `setContext`);
context propagation resubscribes every hook to the new client.

## Hooks are `useSyncExternalStore` over per-Flag subscription

Each hook is one `useSyncExternalStore` per rendered call site:

- **subscribe**: `(onStoreChange) => client.subscribe(flagKey, onStoreChange)`. Render scoping is
  inherited, not implemented: the client already fires per-Flag listeners only for Flags whose
  entry actually changed in a swap ([browser-client.md](./browser-client.md), Revalidation), so a
  change to flag A re-renders exactly A's subscribers. The react layer performs no diffing of its
  own.
- **getSnapshot**: the client's **held entry reference** for the key (`undefined` while absent).
  Entry identity is the change signal: an atomic swap replaces only changed entries, so an
  unchanged Flag keeps its reference and React bails out. The snapshot is deliberately _not_
  `evaluateDetails(key, default)`: that call allocates and embeds the caller default, so an
  inline-literal default (`useFlag("k", { a: 1 })`) would produce a fresh snapshot every render and
  loop. The react entry lives in the same package and reads the entry through an internal seam —
  no new public accessor is added to the browser client.
- **getServerSnapshot**: the same read. It is valid exactly when the client is readable without
  `init()` — under bootstrap ([browser-client.md](./browser-client.md), Bootstrap). Without
  bootstrap, a server render throws `SDK_NOT_INITIALIZED` like any other pre-init read.
- **derivation**: the hook's return value comes from `evaluate`/`evaluateDetails`, called outside
  the snapshot and memoized on the entry reference plus `flagKey` and `defaultValue`. The memo
  re-runs only when the entry swaps or the caller changes inputs; an unstable inline default
  re-runs the memo but never re-renders (snapshots compare entry identity, not derived values).

Two guarantees this shape requires of the browser client (normative for SPL-332, restated in
[browser-client.md](./browser-client.md)):

1. `subscribe(flagKey, listener)` accepts keys absent from the held evaluations. The subscription
   registers by key; if a later swap introduces the Flag, its listeners fire and subscribers
   re-render from the caller default onto the real Variant.
2. Held Variant values are returned by reference, never cloned, and are immutable. JSON Variants
   keep referential identity across renders until a swap — safe in dependency arrays.

## Exposure semantics under React render mechanics

A hook read **is** the exposing read: mounting a component that calls `useFlag` is the moment the
Entity encounters the Variant, and the first read enqueues the Flag's ticket redemption
([browser-client.md](./browser-client.md), Exposure queue). React's render mechanics cannot
double-fire it:

- Repeat renders hit the memo and read nothing.
- Strict Mode double-render, remount, and multiple components reading the same Flag all reduce to
  repeat reads — the queue enqueues at most once per held ticket, so idempotency lives in the
  client, not in render timing.
- A revalidation swap that changes the Flag re-renders its subscribers; the re-run derivation reads
  the new entry and redeems the **new** ticket. The client's "arms the next read" rule composes
  with the hook for free.
- `subscribe` alone fires nothing (subscribing is not a read); there is no hook that subscribes
  without reading.
- SSR with bootstrap: server-render hook reads enqueue redemptions in the server-side client
  instance. Whether that queue ever flushes before the response ends, pipeline first-touch dedup
  (ADR-0005) makes server+browser double-fire safe — no react-layer special-casing.

## Fail-loud (ADR-0036)

Hooks never invent defaults and never downgrade an error to a value:

| State                                        | Behavior                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Any hook outside a `SplitchProvider`         | throws `SplitchSdkError SDK_REACT_PROVIDER_MISSING` during render (message names `SplitchProvider`)                                  |
| Read before `init()` resolves (no bootstrap) | throws the client's `SDK_NOT_INITIALIZED` during render → nearest error boundary. Gate rendering on `await init()`, or bootstrap     |
| Flag key absent from the held evaluations    | the client's row unchanged: `useFlag` returns the caller default with the loud log; `useFlagDetails` gets `ERROR` / `FLAG_NOT_FOUND` |
| Stale (revalidation failing)                 | the client's row unchanged: held value; `STALE` surfaces through `useFlagDetails` and the logger                                     |

`SDK_REACT_PROVIDER_MISSING` is a new `SplitchSdkError` code (`packages/sdk/src/errors.ts`
vocabulary). Throwing during render is deliberate: a missing provider or an un-inited client is a
wiring bug, and rendering nothing-in-particular would be the silent default ADR-0036 forbids. There
is no loading-state or status hook in v1 — Suspense mode is explicitly out of scope (SPL-334) and a
boolean `isReady` hook would be a second way to express what `await init()` before render already
expresses.

## Sources

- [browser-client.md](./browser-client.md) — the client every semantic here rides on
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md), [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [OpenFeature React SDK](https://openfeature.dev/docs/reference/technologies/client/web/react) — pattern reference only, not a dependency
- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- `packages/sdk/CONTEXT.md` — accessor vocabulary (`evaluate` is the exposing read)
