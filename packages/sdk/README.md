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

## Browser client (`@splitch/sdk/browser`)

Static-context client for browsers: one Evaluation Context, one Precomputed
Evaluations fetch, then synchronous Flag reads with zero per-read network.
Exposures fire on the first local read by redeeming Exposure Tickets.

```ts
import { createSplitchBrowserClient } from "@splitch/sdk/browser";

const splitch = createSplitchBrowserClient({
  clientKey: "pk_...", // secrets (sk_/ak_) throw at construction
  context: { targetingKey: user.id },
});
await splitch.init();

const on = splitch.evaluate("new-checkout", false); // sync
const details = splitch.evaluateDetails("new-checkout", false);
await splitch.flush();
```

Reading before `init()` throws `SDK_NOT_INITIALIZED`. An unknown Flag Key returns
your default with `reason: "ERROR"` / `FLAG_NOT_FOUND` and a loud log — never a
silent invented default.

`flush()` drains the Exposure queue. If the queue hits the batch caps (25 items /
32 KiB) and a forced flush fails, the oldest 25 items are retained for retry by
item count; retained items are not additionally bounded by the byte cap. Only
the excess tail is dropped loudly (`RATE_LIMITED`). A single-batch queue that
fails once drops nothing. Retryable delivery failures make at most three total
attempts; a non-retryable 4xx stops automatic delivery after its first attempt.
Both terminal paths log loudly and retain the items for an explicit `flush()`.

## Convex

Convex's default runtime is a custom V8 isolate (no Node built-ins). `fetch` is
available in **actions** and **HTTP actions** only — not in queries or
mutations
([Runtimes](https://docs.convex.dev/functions/runtimes),
[Actions](https://docs.convex.dev/functions/actions),
[Query functions](https://docs.convex.dev/functions/query-functions)).

Call `@splitch/sdk` from an action (or HTTP action), then hand the result to
queries/mutations as ordinary data:

```ts
// convex/flags.ts — action (has fetch)
import { createSplitchClient } from "@splitch/sdk";
import { action } from "./_generated/server";
import { v } from "convex/values";

export const evaluateFlag = action({
  args: {
    flagKey: v.string(),
    targetingKey: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (_ctx, args) => {
    const splitch = createSplitchClient({
      // Client Key for Exposure-bearing evaluate; from Convex env vars.
      clientKey: process.env.SPLITCH_CLIENT_KEY!,
      endpoint: process.env.SPLITCH_ENDPOINT,
    });
    return await splitch.evaluate(args.flagKey, {
      targetingKey: args.targetingKey,
      idempotencyKey: args.idempotencyKey,
      defaultValue: false,
    });
  },
});
```

### Bootstrap for the browser client

An [HTTP action](https://docs.convex.dev/functions/http-actions) is the natural
place to mint Precomputed Evaluations for SSR / hydration. Use an **API Key**
from [Convex environment variables](https://docs.convex.dev/production/environment-variables)
— never ship an API Key into Convex client-side code:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { createSplitchClient } from "@splitch/sdk";

const http = httpRouter();

http.route({
  path: "/splitch/bootstrap",
  method: "POST",
  handler: httpAction(async (_ctx, request) => {
    const { targetingKey } = await request.json();
    const splitch = createSplitchClient({
      apiKey: process.env.SPLITCH_API_KEY!,
    });
    // { context, evaluations, etag } — browser client's bootstrap input
    const precomputed = await splitch.evaluateAll({ targetingKey });
    return new Response(JSON.stringify(precomputed), {
      headers: { "content-type": "application/json" },
    });
  }),
});

export default http;
```

Fail-loud is unchanged in the isolate: missing credentials throw at
construction; transport failures surface as `reason: "ERROR"` on
`evaluate` / `evaluateDetails`, or as a thrown `SplitchSdkError` on
`evaluateAll`.

A `convex-test` fixture under `fixtures/convex-sdk-consumer/` is exercised by
`pnpm --filter @splitch/sdk test:consumer-smoke`.

## Links

- SDK guide: <https://splitch.dev/docs/sdk/install>
- Error catalog: <https://splitch.dev/docs#errors>
- Quickstart: <https://splitch.dev/quickstart>
- Machine-readable index: <https://splitch.dev/llms.txt>
- Platform: <https://splitch.dev>
