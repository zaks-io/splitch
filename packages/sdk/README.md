# @splitch/sdk

Typed feature flags and experiments, evaluated at the edge. One HTTP call per
evaluation, no local config to sync, and every failure is loud: an error is
always observable, never a silently disguised default.

Full platform quickstart (create an App, mint keys, first Flag):
<https://splitch.dev/quickstart>

## Install

```bash
npm install @splitch/sdk
```

ESM only. Node >= 20, browsers, and edge runtimes. `zod` is the sole dependency.

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

| Option      | Credential                | Where it may live                                   | Unlocks                                 |
| ----------- | ------------------------- | --------------------------------------------------- | --------------------------------------- |
| `clientKey` | public Client Key (`pk_`) | browsers, mobile, servers — anything that evaluates | `evaluate`, `evaluateDetails`, `verify` |
| `apiKey`    | secret API Key (`sk_`)    | servers only; never ship it to a client             | `peekVariant`, `verify`                 |

A server-side integration that fires Exposures uses a Client Key, not an API
Key. The API Key cannot call `evaluate` or `evaluateDetails`; present a Client
Key on that path (Client Keys are safe to use from servers).

## The four methods

An **Exposure** is the "this subject saw this Variant" event that experiment
analysis counts. Which methods fire one is the core thing to get right:

| Method            | Returns                  | Fires an Exposure | Credential            |
| ----------------- | ------------------------ | ----------------- | --------------------- |
| `evaluate`        | the Variant value        | yes               | Client Key only       |
| `evaluateDetails` | full `ResolutionDetails` | yes               | Client Key only       |
| `peekVariant`     | the Variant value        | no                | API Key only          |
| `verify`          | full `ResolutionDetails` | no                | Client Key or API Key |

Use `evaluate` on the real user path. Use `peekVariant` to inspect a resolution
without polluting experiment data. Use `verify` to confirm setup end to end
(same shape as `evaluateDetails`, no Exposure, safe to run repeatedly).

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
- `peekVariant` throws a `SplitchSdkError` carrying `code` and `status`.
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

## Links

- Quickstart: <https://splitch.dev/quickstart>
- Platform: <https://splitch.dev>
