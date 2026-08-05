# Precomputed Evaluations decouple resolution from Exposure via redeemable Exposure Tickets

**Status:** accepted

Static-context clients — a browser session, an SSR render hydrating into one — need every Flag for
one Evaluation Context in one round trip, then synchronous local reads with no flicker and no
per-read network. The existing data plane cannot serve that: `evaluate` is one Flag per call and
fires an Exposure at resolution time (ADR-0004), so a bulk fetch built on it would count Exposures
for Flags the user never encounters, and a bulk fetch built without it would lose the experiment
denominator entirely. Shipping Targeting Rules for local evaluation is already forbidden (ADR-0018;
`packages/sdk/CONTEXT.md`).

## Decision

1. **`POST /api/sdk/evaluate-all` returns Precomputed Evaluations**: per-Flag, non-revealing
   `ResolutionDetails` for one Evaluation Context, covering every Flag in the credential's App and
   Environment. The route is structurally non-exposing (like `verify`), replays Assignment Store
   holdovers read-only, resolves through the same evaluate-path resolver as `evaluate` (one engine,
   no drift), and carries an `ETag` for cheap revalidation. A fetch of N Flags bills N Evaluations
   (ADR-0033); local reads of the result bill zero.

2. **Each fresh live-Run assignment in the result carries an Exposure Ticket**: an opaque,
   HMAC-signed, TTL-bound voucher minted by the Evaluation Worker over the exposure-relevant fields
   (App, Environment, Experiment, Run, Flag, Variant name, idType, Targeting Key hash, issue time).
   Tickets are stateless — verification is recomputing the MAC, not a lookup — so issuing them costs
   no storage on the hot path. Holdover replays, disabled Flags, no-live-Run and failed resolutions
   carry no ticket, exactly the cases where `evaluate` records no Exposure today.

3. **Exposure fires on first local read.** When application code first reads a Flag from the held
   Precomputed Evaluations, the SDK redeems that Flag's ticket via batched
   `POST /api/sdk/exposures`. The Worker verifies the ticket, seals the canonical Exposure payload
   (identical shape to the one `evaluate` seals), and then triggers the Assignment Store
   `put` — the same commit `evaluate` performs inline, deferred to the moment of experience. Every
   Exposure-relevant field is derived from the verified ticket, never from client assertion, so a
   client cannot claim a Variant it was not assigned. This **extends** ADR-0004 rather than
   reversing it: "read" was always the moment the Entity encounters the Variant; for a
   payload-backed client that moment is the local read, not the fetch.

4. **Freshness is ETag revalidation polling in v1** (default ~60s), riding the same accepted
   propagation window as the rest of the data plane (ADR-0009). The ADR-0019 hibernating-WebSocket
   nudge extends this later as a data-free "revalidate now" signal; polling remains the fallback.

## Considered options

- **Fire Exposures at fetch time** — rejected. An Exposure without experience poisons the Run
  denominator: a 40-Flag app would expose every Entity to every Experiment on page load. This is the
  same reasoning that keeps `verify` and `peek` non-exposing (ADR-0026, ADR-0037).
- **Ship the ruleset and evaluate locally** (GrowthBook model) — rejected. Rules, salts, and
  allocation never leave the server (ADR-0018), and a client-side engine must bit-match server
  bucketing forever — a permanent drift liability for zero disclosure benefit.
- **Trust client-reported Exposures without tickets** (Statsig client model) — rejected. A public
  Client Key could then inject Exposures claiming arbitrary Variants, silently corrupting SRM and
  first-touch analysis. The ticket makes the forged-assignment attack structurally impossible, not
  merely rate-limited.
- **Server-side pending-Exposure state instead of tickets** — rejected. Recording every issued
  resolution server-side means a durable write per fetched Flag on the hot path (the cost ADR-0009
  confines to first-touch only). The MAC gives the same integrity stateless.
- **SSE streaming for freshness** — rejected for the same reason as ADR-0019: Durable Objects
  hibernate WebSockets, not SSE streams; and v1 does not need push at all.

## Consequences

- **The allocation-oracle boundary (ADR-0034) is unchanged in kind.** `evaluate-all` under a Client
  Key discloses exactly what N `verify` calls already disclose (Variant value, name, non-revealing
  reason). The oracle attack sweeps Targeting Keys, and each swept key still costs a rate-limited
  request; batching is across Flags, not keys. To keep the disclosure destination-fixed, the
  response uses the non-revealing reason set on **every** credential tier — an API Key holder who
  wants rule identity uses `peek` or test-eval, because Precomputed Evaluations are designed to be
  serialized into public pages for bootstrap.
- **Sticky experience commits at redemption.** The Assignment Store write moves from resolution
  time to first-read time. Between fetch and redemption a concurrent evaluation recomputes the same
  deterministic `assign()` (ADR-0001), so the window is the same cosmetic, self-healing class as the
  ADR-0009 propagation window. An unredeemed ticket produces no Exposure and no holdover — correct,
  because the Entity never experienced the Variant.
- **Duplicate and replayed redemptions are already safe.** Pipeline first-touch dedup (ADR-0005) is
  authoritative; a scraped or double-flushed ticket at worst re-appends a raw row that collapses to
  the existing first touch.
- `docs/spec/sdk/openfeature-deferred.md` items 4 (batch evaluation) and 5 (config streaming) are
  resolved by this ADR; the remaining provider-surface deferrals stand.

## Sources

- [ADR-0001](./0001-assignment-is-pure-not-an-event.md), [ADR-0004](./0004-exposure-fires-on-read.md),
  [ADR-0005](./0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [ADR-0009](./0009-assignment-store-substrate-kv-read-do-write.md),
  [ADR-0018](./0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md),
  [ADR-0019](./0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [ADR-0033](./0033-v1-billing-is-an-organization-scoped-evaluation-quota.md),
  [ADR-0034](./0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md),
  [ADR-0036](./0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md),
  [ADR-0037](./0037-client-side-configuration-verification-tiered-by-credential.md)
- [spec/sdk/evaluate-all-endpoint.md](../spec/sdk/evaluate-all-endpoint.md),
  [spec/sdk/exposures-endpoint.md](../spec/sdk/exposures-endpoint.md),
  [spec/sdk/browser-client.md](../spec/sdk/browser-client.md)
