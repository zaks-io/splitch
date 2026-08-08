# @splitch/sdk

Typed feature flags and experiments, evaluated at the edge. One HTTP call per
evaluation, no local config to sync, and every failure is loud: an error is
always observable, never a silently disguised default.

- Full SDK guide: <https://splitch.dev/docs/sdk/install>
- Platform quickstart (create an App, mint keys, first Flag):
  <https://splitch.dev/quickstart>
- Every failure code, with its cause and its fix:
  <https://splitch.dev/docs#errors>

## Install

```bash
npm install @splitch/sdk
```

ESM only. Node >= 20, browsers, and edge runtimes. Zero runtime dependencies —
response validation is a hand-maintained zod-free mirror bundled at build time
(parity-tested against contracts Zod; not codegen).

## Hello world

Paste the `keyMaterial` field from `splitch client-key get` (a `pk_…` value). The response's
`keyId` (`ck_…`) identifies the key; it is not the credential.

```ts
import { createSplitchClient } from "@splitch/sdk";

const splitch = createSplitchClient({ clientKey: "pk_..." });

const variant = await splitch.evaluate("new-checkout", {
  targetingKey: user.id,
  idempotencyKey: crypto.randomUUID(),
  defaultValue: false,
});
```

## Credentials

Construct the client with exactly one credential (anything else throws):

| Option      | Credential                | Where it may live                                  | Unlocks                                                |
| ----------- | ------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `clientKey` | public Client Key (`pk_`) | browsers, mobile, servers: anything that evaluates | `evaluate`, `evaluateDetails`, `verify`, `evaluateAll` |
| `apiKey`    | secret API Key (`sk_`)    | servers only; never ship it to a client            | `peekVariant`, `verify`, `evaluateAll`                 |

A server-side integration that fires Exposures uses a Client Key, not an API
Key. The API Key cannot call `evaluate` or `evaluateDetails`; present a Client
Key on that path (Client Keys are safe to use from servers).

## The five methods

An **Exposure** is the "this subject saw this Variant" event that experiment
analysis counts. Which methods fire one is the core thing to get right:

| Method            | Returns                       | Fires an Exposure | Credential            |
| ----------------- | ----------------------------- | ----------------- | --------------------- |
| `evaluate`        | the Variant value             | yes               | Client Key only       |
| `evaluateDetails` | full `ResolutionDetails`      | yes               | Client Key only       |
| `peekVariant`     | the Variant value             | no                | API Key only          |
| `verify`          | full `ResolutionDetails`      | no                | Client Key or API Key |
| `evaluateAll`     | every Flag, in one round trip | no                | Client Key or API Key |

Use `evaluate` on the real user path. Use `peekVariant` to inspect a resolution
without polluting experiment data. Use `verify` to confirm setup end to end
(same shape as `evaluateDetails`, no Exposure, safe to run repeatedly). Use
`evaluateAll` to render a whole page from one request.

## evaluateAll: every Flag in one round trip

`evaluateAll(context)` resolves every Flag in the credential's App and
Environment for one Evaluation Context and returns them together with the
`ETag` they were tagged with:

```ts
const precomputed = await splitch.evaluateAll({ targetingKey: user.id });

precomputed.context; // { targetingKey, idType, attributes }, defaults applied
precomputed.evaluations; // { [flagKey]: { variant, variantName, reason, errorCode, exposureTicket } }
precomputed.etag; // strong validator for revalidation
```

It fires no Exposure. Each fresh assignment under a live experiment Run carries
an `exposureTicket` instead, which a client redeems when it actually reads that
Flag, so a page that renders 20 Flags and shows 3 records 3 Exposures rather
than 20.

The payload carries no rule logic: results are values, Variant names,
non-revealing reasons, and tickets, never Targeting Rules, rollout percentages,
or the salt. That is what lets you serialize it into a server-rendered page for
the browser client to hydrate from:

```ts
// SSR handler
const precomputed = await splitch.evaluateAll({ targetingKey: user.id });
html.embed(JSON.stringify(precomputed));
```

One caveat before you embed it: alongside the results, the payload echoes the
Evaluation Context it was resolved for, including `targetingKey` and every
attribute you passed. The browser client deep-equality-checks that context to
prove it is hydrating its own Entity's results. So anything you put in
`attributes` (email, plan, country, internal segment names) is published in page
source. Pass only attributes you would publish, and hash or omit the rest.

`idempotencyKey` is optional here: the SDK mints one per fetch. Pass your own
only when you retry an uncertain fetch and want the retry to bill zero. In a
runtime without `crypto.randomUUID` (it is secure-context-only, so plain
`http://` pages lack it) the SDK will not invent a weaker one: the call throws
`SDK_IDEMPOTENCY_KEY_UNAVAILABLE` and you supply the key yourself.

Unlike `evaluate`, it has no Default Variant to fall back to, so it throws a
`SplitchSdkError` on failure rather than returning a partial or empty payload.

## idempotencyKey

`evaluate` and `evaluateDetails` require `idempotencyKey`: a caller-owned id for
one logical evaluation. Generate it once per evaluation
(`crypto.randomUUID()`), and reuse the same key if you retry an uncertain
request so the platform can deduplicate the Exposure.

## Failure behavior

- `evaluate` / `evaluateDetails` / `verify` never throw and never retry. On any
  failure (HTTP error, timeout, network error, unparseable body) they return
  your `defaultValue` (or `false` when you gave none), log loudly through
  `logger.error`, and report `reason: "ERROR"` plus an `errorCode` in
  `ResolutionDetails`. Branch on `reason` when you need to react.
- `peekVariant` and `evaluateAll` throw a `SplitchSdkError` carrying `code`,
  `status`, and `docsUrl`. Every code resolves to a page at
  `https://splitch.dev/docs/error/{code}`, and the error message prints it.
- `retries` must be `0`. A retry is a fresh resolution and would double-count
  Exposures; retry by reusing `idempotencyKey` instead.

## Exposure dedup

Repeat `evaluate` calls for the same Flag and `targetingKey` within the
revalidation window (`revalidateMs`, default 60 seconds) replay locally with
`reason: "CACHED"` and fire no second Exposure. When a new experiment Run
starts, the SDK detects the boundary within that window and fires a fresh
Exposure. Errors are never cached.

## Options

Every option is documented in the shipped type declarations
(`dist/index.d.ts`); highlights:

| Option      | Default                    | Notes                                       |
| ----------- | -------------------------- | ------------------------------------------- |
| `endpoint`  | `https://edge.splitch.dev` | override for self-hosted or preview targets |
| `timeoutMs` | `5000`                     | per-call timeout; a timeout is an ERROR     |
| `retries`   | `0`                        | must stay `0` (see above)                   |
| `logger`    | `console`                  | receives every fail-loud report             |
| `transport` | built-in `fetch` adapter   | injectable seam for tests                   |

`transport` gained a required `evaluateAll` method in the release that added
`evaluateAll`. It is required rather than optional so a stale transport fails at
the type level instead of resolving `undefined` into an `await`. If you pass your
own object literal there, add the method; the type will tell you. Nothing else is
affected, and the built-in adapter needs no change.

## Links

- SDK guide: <https://splitch.dev/docs/sdk/install>
- Error catalog: <https://splitch.dev/docs#errors>
- Quickstart: <https://splitch.dev/quickstart>
- Machine-readable index: <https://splitch.dev/llms.txt>
- Platform: <https://splitch.dev>
