# Control-plane JWKS fetches use the Workers subrequest cache

**Status:** accepted

Control-plane authentication verifies RS256 signatures against the Auth API's public JSON Web Key
Set. The resolver already keeps parsed keys in a process-local map, but Cloudflare isolates are
recycled between requests. Production traces showed that 7 of 13 `GET /apps/*/flags` requests
fetched `/.well-known/jwks.json`, adding 278 ms at p50 and 338 ms at p95 ahead of 137 ms p50 of
handler work.

## Decision

1. **The default JWKS transport uses Cloudflare's `fetch()` subrequest cache.** Its request sets
   `cacheEverything` with `cacheTtlByStatus` rather than a flat `cacheTtl`. The Cloudflare docs
   describe `cacheTtlByStatus` as "a version of the `cacheTtl` feature" that selects the TTL from
   the response status, so setting both would state the window twice; the by-status form is the one
   that can refuse to cache a fault. Only 2xx responses receive the 300-second TTL; 3xx, 4xx, and
   5xx receive zero. A transport fault therefore still reaches jose and fails authentication loud.

2. **The resolver partition remains a property of the caller's fetch argument.** No caller-supplied
   fetch means the `default` partition and the shared cached transport. A caller-supplied fetch,
   including the tenant-JWKS transport, keeps its own `custom:N` partition and is invoked without
   Cloudflare cache options.

3. **The shared cache TTL is 300 seconds.** CLI sessions and Control Panel loads create bursts of
   authenticated requests. One request in a colo pays the JWKS fetch during that window and the
   rest reuse it across isolates.

4. **Key rotation accepts up to 300 seconds of propagation lag per colo.** jose refreshes after an
   unknown `kid`, but that refresh can receive the cached key set for the rest of the TTL. Emergency
   rotation therefore requires a Cloudflare cache purge of the JWKS URL. This is an operational
   lever, not new product tooling.

5. **An unknown `kid` never bypasses the shared cache.** A bypass would let an attacker turn
   garbage `kid` values into an uncached-fetch amplifier against the Auth API. The bounded rotation
   window is the accepted trade.

6. **Caching changes only public-key retrieval.** A JWKS is public by definition. RS256 signature
   verification and the existing `aud` and `exp` assertions remain unchanged. A stale, missing, or
   failed cache entry never degrades verification into a pass.

7. **The Auth API advertises the same cache window.** Successful JWKS responses carry
   `Cache-Control: public, max-age=300`, which lets every compliant consumer cache the public key
   set on the same contract.

## Consequences

- Bursty control-plane authentication normally performs one Auth API JWKS fetch per colo per five
  minutes instead of one fetch per fresh isolate.
- A routine signing-key rotation can take up to five minutes to become usable in a colo.
- Emergency rotation includes purging the Auth API JWKS URL from Cloudflare's cache.
- Tenant-JWKS callers retain their current uncached custom transport and resolver isolation.

## Sources

- [Cloudflare Cache: Interaction with Cloudflare products](https://developers.cloudflare.com/cache/interaction-cloudflare-products/workers/)
- [Cloudflare Workers: Cache using fetch](https://developers.cloudflare.com/workers/examples/cache-using-fetch/)
- [ADR-0036](./0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
