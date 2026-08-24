# Convex consumer fixture

Proves `@splitch/sdk` inside Convex's isolate (SPL-336):

- A Convex **action** calls `evaluate` / `evaluateDetails` (the only function
  types with `fetch` — see [Actions](https://docs.convex.dev/functions/actions)
  and [Runtimes](https://docs.convex.dev/functions/runtimes)).
- A **mutation** stores the result; a **query** reads it as data (queries and
  mutations cannot `fetch`).
- An **action** resolves a Flag once and passes its boolean plus Variant name
  through validated args to an internal mutation.
- An **HTTP action** calls `evaluateAll` and returns the Precomputed Evaluations
  payload for browser bootstrap
  ([HTTP actions](https://docs.convex.dev/functions/http-actions)).

This directory is **outside** the pnpm workspace graph. Install only from a
packed `@splitch/sdk` tarball — never link monorepo packages.

## Run via consumer smoke

From the repo root (after `@splitch/sdk` is built):

```bash
pnpm --filter @splitch/sdk test:consumer-smoke
```

That extracts the README's query/mutation example into this fixture, packs the
SDK, installs the fixture into a temp consumer with the tarball, typechecks it
against generated-shape Convex API types, and runs `vitest` under `convex-test`
([convex-test](https://docs.convex.dev/testing/convex-test)).

## Transport seam

Tests stub the global `fetch` at the fixture seam (no live edge). The stub is a
**receiver-identity** `function` that throws `Illegal invocation` when called
detached from `globalThis` — the same failure mode as browser / workerd
`fetch` — so a missing SDK `.bind(globalThis)` turns the suite red. See
`convex/testHelpers.ts`.

## Credentials

Put `SPLITCH_API_KEY` / `SPLITCH_CLIENT_KEY` (and optional `SPLITCH_ENDPOINT`)
in [Convex environment variables](https://docs.convex.dev/production/environment-variables).
Never ship an API Key into Convex client-side code.
