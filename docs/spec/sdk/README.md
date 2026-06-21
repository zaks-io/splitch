# SDK area spec index

Spine: the SDK is a thin JS/TS HTTP client (v1). One public accessor fires an Exposure; a
distinct accessor peeks without one. The evaluate endpoint is safe under a public Client Key
(returns only the resolved Variant, never config/rules/salt). The full OpenFeature provider
surface is deferred.

## Files

| File | One-line purpose |
|------|-----------------|
| [credentials.md](./credentials.md) | Client Key vs API Key: which credential, what it can do, lifecycle |
| [public-evaluate-endpoint.md](./public-evaluate-endpoint.md) | `POST /evaluate` contract: request/response shapes, safety invariants, edge binding |
| [exposure-accessor.md](./exposure-accessor.md) | `evaluate` (fires Exposure) and `peekVariant` (no Exposure) |
| [seen-set.md](./seen-set.md) | SDK-local per-instance exposure dedup cache (hot-path optimization only) |
| [assignment-store-integration.md](./assignment-store-integration.md) | How the SDK consumes the Assignment Store (holdover pre-load, evaluate-path ordering) |
| [five-runtimes.md](./five-runtimes.md) | SDK invariants across five Cloudflare edge runtimes |
| [test-evaluation-endpoint.md](./test-evaluation-endpoint.md) | Control-plane dry-run: `POST /test-evaluation` — resolves without Exposure |
| [openfeature-deferred.md](./openfeature-deferred.md) | Explicitly-deferred full OpenFeature provider surface (v1 out of scope) |

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [ADR-0026](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
