# Browser client: static-context Precomputed Evaluations, synchronous reads

The static-context client (OpenFeature "static context paradigm": one process serves one user for a
session). It fetches the [Precomputed Evaluations](./evaluate-all-endpoint.md) once for one
Evaluation Context, then serves **synchronous** Flag reads with zero per-read network. Exposures
fire on first local read by redeeming [Exposure Tickets](./exposures-endpoint.md) (ADR-0048). The
root `createSplitchClient` remains the dynamic-context client (per-call context, remote resolution)
for servers and edge runtimes; the browser client is the recommended surface for browsers.

## Packaging

One npm package, subpath exports — never per-environment packages:

```
@splitch/sdk            -- dynamic-context server client (existing surface + evaluateAll)
@splitch/sdk/browser    -- this client
@splitch/sdk/react      -- provider + hooks over this client (react as optional peer)
```

The `./react` surface (provider shape, hook API, subscription seam) is specified in
[react-bindings.md](./react-bindings.md).

Each subpath is a separate bundle entry with its own size budget; server-only code never enters the
browser entry and vice versa. The published package has no runtime zod (SPL-325); response
validation uses validators compiled from the contract surface at build time.

## Construction

```ts
import { createSplitchBrowserClient } from "@splitch/sdk/browser";

const splitch = createSplitchBrowserClient({
  clientKey: "pk_...", // required; an sk_/ak_ secret here THROWS at construction
  context: { targetingKey: userId }, // required; ONE Evaluation Context for the client's lifetime
});
await splitch.init(); // one evaluate-all fetch
```

| Option                     | Required | Default                    | Notes                                                                                 |
| -------------------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------- |
| `clientKey`                | yes      | —                          | `pk_…` only. A secret key throws `SDK_CREDENTIAL_CONFIGURATION_INVALID`.              |
| `context`                  | yes      | —                          | `{ targetingKey, idType?, ...attributes }`; `idType` defaults to `'user'` (ADR-0036). |
| `bootstrap`                | no       | `null`                     | A server-produced `evaluateAll` result + its context (see Bootstrap).                 |
| `revalidateMs`             | no       | `60_000`                   | ETag revalidation interval; `0` disables the loop.                                    |
| `endpoint`                 | no       | `https://edge.splitch.dev` | Same default table as the root client.                                                |
| `timeoutMs`                | no       | `5000`                     | Per network call.                                                                     |
| `fetch` / `logger` / `now` | no       | platform / console / Date  | The root client's injectable seams, unchanged.                                        |

Construction performs no I/O and touches no browser API (same rule as the root client). The context
is fixed for the client's lifetime — changing user means constructing a new client (static-context
paradigm; no `setContext` in v1).

## Lifecycle and synchronous accessors

```ts
await splitch.init(); // fetch; no-op when bootstrapped
const value = splitch.evaluate("new-checkout", false); // sync; queues Exposure redemption
const details = splitch.evaluateDetails("new-checkout", false); // sync; full ResolutionDetails
const stop = splitch.subscribe("new-checkout", (details) => rerender());
await splitch.flush(); // acknowledged queue flush
await splitch.close(); // final flush; stops timers/listeners
```

The accessor names keep the repo's exposure vocabulary: **`evaluate` is the exposing read** on both
paradigms (`packages/sdk/CONTEXT.md`); only the transport moment differs. There is no `peek` on the
browser client (Client Key, ADR-0034) and no per-call `idempotencyKey` — the SDK owns fetch and
redemption identity (see [evaluate-all-endpoint.md](./evaluate-all-endpoint.md) Billing and
[exposures-endpoint.md](./exposures-endpoint.md) retry identity). The second parameter is the
caller's Default Variant, same as the root client.

Fail-loud rules (ADR-0036):

| Read state                                     | `evaluate` returns                           | `evaluateDetails.reason` / `errorCode`                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before `init()` resolves (and no bootstrap)    | throws `SplitchSdkError SDK_NOT_INITIALIZED` | throws — reading nothing is a bug, not a default                                                                                                              |
| Flag key absent from the held evaluations      | caller default, loud log                     | `ERROR` / `FLAG_NOT_FOUND`                                                                                                                                    |
| Held entry with `reason: ERROR`                | caller default, loud log                     | the entry's `ERROR` / `errorCode`                                                                                                                             |
| Revalidation failing (serving last-known-good) | held value                                   | entry-derived held details reaching the decorator: `STALE` / `PROVIDER_NOT_READY`; absent-flag, held-`ERROR`, and null-variant details: held fields unchanged |
| Normal held entry                              | held value                                   | the entry's `reason` (`SPLIT`/`DEFAULT`/`DISABLED`)                                                                                                           |

`subscribe(flagKey, listener)` registers a per-Flag listener invoked when a revalidation swap
changes that Flag's resolution; it returns an unsubscribe function. Subscribing is **not** a read:
it fires no Exposure until the value is actually read. Errors surface through the injectable
`logger` — no second hook system (the Web Analytics rule, reused). Three guarantees the React
bindings ([react-bindings.md](./react-bindings.md)) depend on: `subscribe` accepts keys absent
from the held evaluations (the subscription registers by key and fires if a later swap introduces
the Flag), and held Variant values are returned by reference — never cloned, treated as immutable —
so identity is stable until a swap; the third is the SPL-333-owned degradation-state read plus
decorator seam specified under [Revalidation](#revalidation).

## Exposure queue (redemption)

The first `evaluate`/`evaluateDetails` read of a Flag whose held entry carries an Exposure Ticket
enqueues exactly one redemption item (`exposureId` minted at enqueue, stable across retries).
Repeat reads enqueue nothing; a revalidation swap that changes the Flag's resolution arms the next
read to redeem the **new** ticket. Entry equality includes the opaque `exposureIdentity` and excludes
the ticket bytes themselves, so a same-Variant Experiment Run rollover re-arms the read while a
routine `issued_at` remint of the same pending Exposure does not. Queue mechanics reuse the Web
Event queue contract (`packages/sdk/CONTEXT.md`) verbatim:

- Memory-only — never IndexedDB, `localStorage`, `sessionStorage`, or cookies.
- Flush at 5 seconds after the first queued item, at the batch caps (25 items / 32 KiB), or when
  the page becomes hidden, with `pagehide` as fallback. No timer or lifecycle listener exists while
  the queue is empty.
- Page-lifecycle delivery uses authenticated `fetch` with `keepalive` (an `Authorization` header is
  required, which rules out `sendBeacon`).
- `flush()` awaits an acknowledged `ExposureBatchResponse` and resolves with the per-item results;
  an empty queue resolves without network I/O.
- A failed flush is logged loudly. Batch-level transport failure and per-item
  `SERVICE_UNAVAILABLE` retain the same `exposureId`s for the next flush and make at most three
  automatic delivery attempts. An explicit `flush()` can still send retained items after automatic
  delivery stops. Deterministic per-item rejections (`INTERNAL_SERVER_ERROR`, `VALIDATION_ERROR`,
  ticket faults, conflicts) are acknowledged as failed and dropped — see
  [exposures-endpoint.md](./exposures-endpoint.md) Redemption semantics. Queue-cap overflow
  drops nothing silently — it forces an immediate flush, and if that fails the overflow is
  logged as an explicit loss with count (fail-loud, never invisible).

## Bootstrap (SSR hydration)

The server renders with the same values the browser will hold, then hands them over — zero flicker,
zero init fetch:

```ts
// server (SSR handler; API Key)
const precomputed = await splitch.evaluateAll({ targetingKey: userId });
html.embed(JSON.stringify(precomputed));

// browser
const splitch = createSplitchBrowserClient({
  clientKey: "pk_...",
  context: { targetingKey: userId },
  bootstrap: precomputed, // { context, evaluations, etag }
});
splitch.evaluate("new-checkout", false); // sync, immediately — init() not required first
```

- The bootstrap object carries the context it was evaluated for. If it does not match the client's
  `context` (canonical deep-equality: `targetingKey`, `idType`, attributes), construction **throws**
  `SplitchSdkError SDK_BOOTSTRAP_CONTEXT_MISMATCH` — the client never enters a usable state serving
  another Entity's Variants. Fail-loud, never a silent refetch that masks a wiring bug upstream.
- A valid bootstrap makes reads available synchronously pre-`init()`; the revalidation loop still
  starts (first tick validates the bootstrap's `etag`). Bootstrap reads bill zero (ADR-0033).
- The serialized object is public page content by design: evaluated results, non-revealing reasons,
  opaque Exposure identities, and tickets only — never rules or salt
  ([evaluate-all-endpoint.md](./evaluate-all-endpoint.md), "destination-fixed"). The API Key stays
  server-side; only `pk_…` reaches the page.

## Revalidation

A single loop revalidates the held evaluations every `revalidateMs` (default 60s) with
`If-None-Match`:

- `304` → no-op. Changed body → **atomic swap**; per-Flag `subscribe` listeners fire only for Flags
  whose entry actually changed. Entry equality compares `variant`, `variantName`, `reason`,
  `errorCode`, and `exposureIdentity`; it excludes `exposureTicket` bytes. The opaque identity changes
  across Experiment Run rollover and fresh-assignment-to-holdover materialization even when the
  visible Variant does not. An ETag-only ticket refresh window may replace ticket bytes without
  changing entry equality, notifying listeners, or re-arming an already-read Exposure.
- Failure → keep serving last-known-good and log loudly every failed tick. Until a tick succeeds,
  the read-time decorator marks only entry-derived held details that reach it `STALE`
  (`errorCode: PROVIDER_NOT_READY`); absent-flag (`ERROR` / `FLAG_NOT_FOUND`), held-`ERROR`, and
  null-variant details bypass it and are never overwritten (ADR-0036).
- SPL-333 owns the current revalidation-degradation state and same-package internal seam. A failed
  tick enters degradation and the next successful tick clears it. The seam exposes both a
  synchronous, render-safe state read and the exact read-time staleness decorator
  `evaluateDetails` uses; neither is public API or a notification channel.
- End-to-end freshness is revalidation interval + the accepted ~60s KV propagation window
  ([five-runtimes.md](./five-runtimes.md), ADR-0009); this client does not try to beat the data
  plane's own propagation. The ADR-0019-style WebSocket nudge, when it lands, only triggers an
  early revalidation tick — polling remains the substrate and fallback.
- `close()` stops the loop; no timers leak.

## Server accessor: `evaluateAll`

The root (dynamic-context) client gains the bulk accessor backing SSR:

```
sdk.evaluateAll(context: EvaluationContext): Promise<PrecomputedEvaluations>
   -- PrecomputedEvaluations = { context, evaluations, etag }
```

Non-exposing, no seen-set interaction, `retries: 0`, structured `SplitchSdkError` failures like
every accessor. Available on both credential tiers with identical disclosure
([evaluate-all-endpoint.md](./evaluate-all-endpoint.md)); the SSR path holds an API Key. Its result
is, byte-for-byte, the browser client's `bootstrap` input — one schema, no copy.

## Relation to existing SDK surfaces

- **Seen-set**: not used. The held Precomputed Evaluations replace it; redemption identity
  (`exposureId` + pipeline first-touch) covers what the seen-set covers on the root client.
- **Web Analytics** (`web.track()` / `web.instrument()`): specified on the root client contract and
  unchanged by this doc. When the browser Web Analytics surface ships, it belongs on this client
  (Web Session is a browser-session concern, matching the static-context lifetime); that move is
  deliberate future work, not scaffolded here.
- **Root client in a browser**: still works (SPL-321's contract), but every read is a network call
  and requires caller-managed `idempotencyKey`s. Docs steer browser consumers here.

## Sources

- [ADR-0048](../../adr/0048-precomputed-evaluations-decouple-resolution-from-exposure-via-exposure-tickets.md) — the model this client implements
- [ADR-0034](../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md), [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [evaluate-all-endpoint.md](./evaluate-all-endpoint.md), [exposures-endpoint.md](./exposures-endpoint.md)
- [OpenFeature SDK paradigms](https://openfeature.dev/docs/reference/concepts/sdk-paradigms/) — static vs dynamic context
- `packages/sdk/CONTEXT.md` — Web Event queue rules this client's exposure queue reuses
