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
vocabulary is preserved one level down — a mounted `useFlag`/`useFlagDetails` is an
`evaluate`/`evaluateDetails` read, **the exposing reads** (`packages/sdk/CONTEXT.md`), with
Exposure timed to the commit (see Exposure fires on commit). The `defaultValue` parameter is the
caller's Default Variant, same position and typing (`VariantValue`) as the client accessors.

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

Each provider owns a decoration-eligibility ref, initially `false`. The provider's mount effect
flips it to `true` without scheduling a state update or an extra render. A render is eligible for
read-time staleness decoration if and only if that provider's mount effect has already run.

## Hooks are `useSyncExternalStore` over per-Flag subscription

Each hook is one `useSyncExternalStore` per rendered call site:

- **subscribe**: `(onStoreChange) => client.subscribe(flagKey, onStoreChange)`, with a function
  identity stable per (client, `flagKey`) — `useCallback` or an equivalent factory — because
  `useSyncExternalStore` resubscribes whenever the subscribe function changes; resubscription
  happens only when the client or the key actually changes. Render scoping is inherited, not
  implemented: the client already fires per-Flag listeners only for Flags whose entry actually
  changed in a swap ([browser-client.md](./browser-client.md), Revalidation), so a change to flag A
  re-renders exactly A's subscribers. The react layer performs no diffing of its own.
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
- **held-resolution derivation**: the hook's render-time held value and held details are derived
  from the held entry through the same internal seam, **not** by calling
  `evaluate`/`evaluateDetails` during render (see Exposure fires on commit). This derivation stays
  memoized on exactly the client, the entry reference, `flagKey`, and `defaultValue`. The client is
  a memo key because a provider swap can change every result while the snapshot stays `undefined`
  (Flag absent from both clients, or the new client un-inited); the memo must never serve one
  client's derivation under another. The held value and held details use the same entry-to-result
  mapping as the client's accessors, never a duplicated mapping. An unstable inline default re-runs
  the memo but never re-renders (snapshots compare entry identity, not derived values).
- **details staleness overlay**: on every decoration-eligible render, after the stable
  held-resolution memo is read, `useFlagDetails` reads the client's current revalidation-degradation
  state through the same-package internal seam. The hook passes the held details through the
  client's own read-time staleness decorator at exactly the same point as `evaluateDetails`; React
  never reimplements the mapping or its application set. The decorator applies exactly where the
  client's `evaluateDetails` applies it: only entry-derived held details that reach that point are
  decorated. Absent-flag details (for example, `ERROR` / `FLAG_NOT_FOUND`), held-`ERROR` details,
  and null-variant details bypass the decorator and render unchanged. When the client is degraded
  and details reach the decorator, it returns the held value with `reason: STALE` and
  `errorCode: PROVIDER_NOT_READY`. The decorator replaces only `reason` and `errorCode`; every other
  details field remains the held resolution's field.

  Staleness is read fresh on every eligible render, but the returned details object must be
  memoized on the pair (held-details identity, current degradation state). While that pair is
  unchanged, `useFlagDetails` returns the same object reference. This identity memo is separate
  from the stable held-resolution memo. Degradation state does not become a snapshot, invalidate a
  held entry, or notify a subscriber.

  Because the overlay reads mutable client state outside `useSyncExternalStore`, components in the
  same render pass may observe different staleness, and a render begun before a failed tick may
  commit un-overlaid details. This intra-commit inconsistency is accepted because staleness is
  read-time metadata corrected on the component's next render.

Three guarantees this shape requires of the browser client (restated in
[browser-client.md](./browser-client.md)). Guarantees 1 and 2 are normative for SPL-332 (shipped);
guarantee 3 is normative for SPL-333, the browser-client revalidation slice:

1. `subscribe(flagKey, listener)` accepts keys absent from the held evaluations. The subscription
   registers by key; if a later swap introduces the Flag, its listeners fire and subscribers
   re-render from the caller default onto the real Variant.
2. Held Variant values are returned by reference, never cloned, and are immutable. JSON Variants
   keep referential identity across renders until a swap — safe in dependency arrays.
3. The client exposes to same-package consumers both a synchronous, render-safe read of its current
   revalidation-degradation state and its read-time staleness decorator, the exact function
   `evaluateDetails` uses. The React bindings call that identical decorator. Neither capability is
   public API or a notification channel.

## Exposure fires on commit, not render

Render is not the exposing read. React starts and discards renders (Strict Mode, concurrent
rendering, a tree unmounted before commit), and an Exposure for a Variant that never reached the
screen would corrupt the Experiment's measurement. The hooks therefore split the read:

- During render, the value is derived from the held entry through the internal non-exposing seam.
  (This is not the `peek` accessor — ADR-0034's peek is an API-Key-only endpoint concern; the seam
  reveals nothing beyond the held entry `evaluate` itself returns.)
- After the component **commits**, an effect performs the exposing read (`evaluate`), and the first
  read of a Flag enqueues its ticket redemption ([browser-client.md](./browser-client.md), Exposure
  queue). The commit is the moment the Entity encounters the Variant, and that is when Exposure
  fires.

React's render mechanics reduce to repeat reads: Strict Mode's double-invoked effects, remounts,
and multiple components reading the same Flag all hit the queue's once-per-held-ticket guard, so
idempotency lives in the client, not in render timing. A revalidation swap that changes the Flag
re-renders its subscribers, the effect re-runs on the new entry, and its exposing read redeems the
**new** ticket — the client's "arms the next read" rule composes with the hook for free.
`subscribe` alone fires nothing (subscribing is not a read); there is no hook that subscribes
without reading.

SSR follows directly: effects do not run during server rendering, so hooks fire **zero** Exposures
server-side. On a bootstrap page ([browser-client.md](./browser-client.md), Bootstrap) the server
renders from the non-exposing `evaluateAll` result, and the browser's hydration commit performs the
first exposing read — exactly one Exposure per read Flag, in the browser, where the Entity actually
sees it. No server-side flush question exists for the hooks; an app that additionally calls
`evaluate` imperatively on the server is outside their concern, and pipeline first-touch dedup
(ADR-0005) keeps any such double-fire safe.

The provider's decoration-eligibility ref remains `false` during server rendering through
`getServerSnapshot` and during the hydration render. Both return the held details unchanged so the
server HTML and hydration output match. The provider's mount effect then flips the ref without a
state update or extra render, and the decorator first applies on the next render caused by
something else. The same rule applies to a client-only tree with no SSR: its first render is not
decoration-eligible, its mount effect schedules no render, and the decorator first applies on its
next render. This delay is accepted for the same reason as intra-commit tearing: staleness is
read-time metadata corrected on the component's next render.

## Fail-loud (ADR-0036)

Hooks add no defaults and no error handling of their own — every row below is the client's
specified behavior surfaced through React:

| State                                        | Behavior                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any hook outside a `SplitchProvider`         | throws `SplitchSdkError SDK_REACT_PROVIDER_MISSING` during render (message names `SplitchProvider`)                                                                                                              |
| Read before `init()` resolves (no bootstrap) | throws the client's `SDK_NOT_INITIALIZED` during render → nearest error boundary. Gate rendering on `await init()`, or bootstrap                                                                                 |
| Flag key absent from the held evaluations    | `useFlag` returns the caller's Default Variant with the client's loud log; `useFlagDetails` returns `value` = caller default, `reason: ERROR`, `errorCode: FLAG_NOT_FOUND` — the error is carried, never dropped |
| Stale (revalidation failing)                 | entry-derived held details that reach the client decorator carry `STALE` on the next eligible render; bypassed details remain unchanged; per-tick logging is immediate                                           |

Staleness is **read-time metadata, not a change event**. A failed revalidation tick changes no
Flag's resolution, so the client fires no per-Flag listeners and subscribers do not re-render for
it. On a decoration-eligible render, `useFlagDetails` must apply the client's current read-time
staleness decorator outside the stable held-resolution memo, so entry-derived held details that
reach the decorator carry `STALE` whenever the component next renders for any other reason.
`useFlag` remains the held value and must not re-render solely because staleness entered or cleared.
This delay is deliberate: re-rendering every subscriber on every failed tick would add a second
notification channel (the Web Analytics rule browser-client.md already reuses) to redraw unchanged
values, while the degraded state is already observable the fail-loud way because the client logs
loudly on every failed tick ([browser-client.md](./browser-client.md), Revalidation).

For browser revalidation, `PROVIDER_NOT_READY` is a details-only `errorCode` admitted by
`SdkResolutionDetails.errorCode` as a union member alongside `SplitchSdkErrorCode`. It is never a
member of `sdkClientErrorCodes` and never a valid thrown `SplitchSdkError` code.

Normative sequence (the server and hydration renders, or the initial render in a client-only tree,
precede this sequence and return unchanged held details; the provider mount effect has then run,
and the held `SPLIT` result below is entry-derived and reaches the client decorator):

1. The first decoration-eligible render returns `useFlagDetails("new-checkout", false)` with the
   held value `true` and held `reason: SPLIT`.
2. The next revalidation fails. The client keeps the same entry reference, logs the failure, and
   invokes no listener registered for `new-checkout`; the component does not re-render from that
   tick.
3. Unrelated component state or props then cause that component to render again.
4. The stable held-resolution memo still supplies value `true`, and the client's shared staleness
   decorator makes `useFlagDetails` return value `true`, `reason: STALE`, and
   `errorCode: PROVIDER_NOT_READY`. Later renders return the same details object reference while the
   held-details identity and degradation state remain unchanged.

## SPL-334 implementation proof obligations

The hook implementation slice must ship tests that prove all of the following:

- The normative sequence above: a successful details render, a failed revalidation with zero
  per-Flag listener calls and zero render caused by the tick, an unrelated render, then the held
  value with `STALE` / `PROVIDER_NOT_READY`.
- Failed revalidation preserves the held entry reference and does not invalidate the
  held-resolution memo. The test must still observe current staleness after an unrelated render,
  proving that the shared decorator is applied outside that memo.
- Repeated decoration-eligible renders for entry-derived held details that reach the decorator
  return the same decorated details object reference while both the held-details identity and
  degradation state are unchanged. A change to either member of that pair recomputes the returned
  details.
- Absent-flag details (including `ERROR` / `FLAG_NOT_FOUND`), held-`ERROR` details, and null-variant
  details retain their held fields and object references while the client is degraded.
- For any held entry and degradation state, `useFlagDetails` and the client's `evaluateDetails`
  staleness decoration produce the same fields because both call the identical decorator at the
  same point.
- A server render and its hydration render both return the unchanged held details even when the
  client is already degraded. The provider mount effect schedules no render; the next render caused
  by something else applies the stale decoration.
- In a client-only tree, the first render returns unchanged held details even when the client is
  already degraded. The provider mount effect schedules no render; the next render caused by
  something else applies the stale decoration.
- A typecheckable assertion proves that a details object carrying `reason: STALE` and
  `errorCode: PROVIDER_NOT_READY` satisfies `SdkResolutionDetails`. `PROVIDER_NOT_READY` is admitted
  by `SdkResolutionDetails.errorCode` as a details-only union member alongside
  `SplitchSdkErrorCode`; the assertion must not make it a member of `sdkClientErrorCodes` or a valid
  thrown `SplitchSdkError` code.
- `useFlag` keeps returning the held value and does not re-render solely when staleness enters or
  clears.
- After a successful recovery tick clears degradation without changing the Flag entry, no per-Flag
  listener fires; on the next unrelated render, `useFlagDetails` returns the memoized held details
  without the stale overlay.
- A subscription-spy test proves that the hooks register only the existing per-Flag subscription
  and that failed revalidation invokes no notification callback. The React bindings must introduce
  no global staleness subscription or second notification channel.

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
