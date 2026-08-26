# SDK area spec index

Spine: the SDK is a thin JS/TS HTTP client in two paradigms. On the dynamic-context (server)
client, `evaluate`/`evaluateDetails` fire an Exposure, `peekVariant` and `verify` resolve without
one, and `evaluateAll` fetches the non-exposing Precomputed Evaluations (ADR-0048). The
static-context browser client holds those Precomputed Evaluations for one Evaluation Context,
serves synchronous reads, and fires Exposure on first read by redeeming Exposure Tickets.
Top-level `track()` submits a strictly validated Metric Event, `web.track()` queues an explicitly
submitted Web Event, and `web.flush()` awaits an acknowledged batch result. `web.instrument()` separately registers explicitly selected automatic
browser signals and returns their scoped cleanup. Browser Web Events use a tab-scoped Web Session by
default and remain outside Experiment measurement. Every evaluation accessor speaks the OpenFeature
`ResolutionDetails` shape and is **fail-loud** — a failure-fallback always carries
`reason: ERROR` + `errorCode`, never a silent default (ADR-0036). `idType` defaults to `'user'`.
The evaluate endpoint is safe under a public Client Key (returns only the resolved Variant and a
non-revealing `reason`, never config/rules/salt). The full OpenFeature _provider_ surface is
deferred; the `ResolutionDetails` _shape_ is not.

## Files

| File                                                                         | One-line purpose                                                                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [credentials.md](./credentials.md)                                           | Client Key vs API Key: which credential, what it can do, lifecycle                                                                      |
| [public-evaluate-endpoint.md](./public-evaluate-endpoint.md)                 | `POST /api/sdk/evaluate` contract: request/response shapes, safety invariants, edge binding                                             |
| [exposure-accessor.md](./exposure-accessor.md#peek-endpoint-shape)           | `POST /api/sdk/peek` contract: API-Key-only non-exposing Variant resolution                                                             |
| [verify-endpoint.md](./verify-endpoint.md)                                   | `POST /api/sdk/verify` contract: non-exposing setup confirmation, reason tiered by credential (ADR-0037)                                |
| [evaluate-all-endpoint.md](./evaluate-all-endpoint.md)                       | `POST /api/sdk/evaluate-all` contract: Precomputed Evaluations, non-exposing, Exposure Tickets, ETag (ADR-0048)                         |
| [exposures-endpoint.md](./exposures-endpoint.md)                             | `POST /api/sdk/exposures` contract: batched Exposure Ticket redemption, forgery-proof, deferred Assignment Store write                  |
| [convex-integration-api.md](./convex-integration-api.md)                     | API-Key installation, config snapshot, signed webhook lifecycle, status, and uninstall                                                  |
| [convex-component.md](./convex-component.md)                                 | `@splitch/convex`: signed nudge/pull sync and local query/mutation evaluation                                                           |
| [convex-exposure-delivery.md](./convex-exposure-delivery.md)                 | Convex mutation Exposure outbox, verified server ingest, retry, and commit-time ordering                                                |
| [cloudflare-integration-api.md](./cloudflare-integration-api.md)             | API-Key registration, signed full-snapshot push, delivery health, and verified Exposure ingest                                          |
| [cloudflare-worker.md](./cloudflare-worker.md)                               | `@splitch/cloudflare`: one-command deployment, service-binding RPC, and durable local Flag and Experiment evaluation                    |
| [browser-client.md](./browser-client.md)                                     | Static-context browser client: sync reads, exposure-on-first-read queue, SSR bootstrap, ETag revalidation                               |
| [react-bindings.md](./react-bindings.md)                                     | `@splitch/sdk/react`: provider + `useFlag`/`useFlagDetails` hooks, `useSyncExternalStore` seam, fail-loud render semantics              |
| [exposure-accessor.md](./exposure-accessor.md)                               | `evaluate` (fires Exposure), `peekVariant` + `verify` (no Exposure)                                                                     |
| [seen-set.md](./seen-set.md)                                                 | SDK-local per-instance exposure dedup cache (hot-path optimization only)                                                                |
| [assignment-store-integration.md](./assignment-store-integration.md)         | How the SDK consumes the Assignment Store (holdover pre-load, evaluate-path ordering)                                                   |
| [five-runtimes.md](./five-runtimes.md)                                       | SDK invariants across five Cloudflare edge runtimes                                                                                     |
| [test-evaluation-endpoint.md](./test-evaluation-endpoint.md)                 | Control-plane dry-run: `POST /apps/:appId/envs/:environmentId/flags/:flagKey/test-eval` — resolves without Exposure (per-Env, ADR-0027) |
| [../pipeline/metric-event-contract.md](../pipeline/metric-event-contract.md) | `track()` and `POST /api/sdk/events`: strict Metric Event validation, identity, version stamping, and idempotency                       |
| [../pipeline/web-event-identity.md](../pipeline/web-event-identity.md)       | Browser Web Session generation and persistence, optional explicit Entity identity, and Experiment exclusion                             |
| [web-analytics-capture.md](./web-analytics-capture.md)                       | Manual `web.track()`, automatic `web.instrument()`, batch-only ingest, memory-only queue, and bounded browser collection                |
| [openfeature-deferred.md](./openfeature-deferred.md)                         | Explicitly deferred full OpenFeature provider surface                                                                                   |

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [ADR-0026](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [ADR-0049](../../adr/0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)
