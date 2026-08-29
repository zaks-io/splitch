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

4. **Key rotation costs up to 300 seconds of extra propagation lag per colo, on top of jose's own
   600-second in-process cache.** jose's `createRemoteJWKSet` defaults `cacheMaxAge` to 600000 ms
   and refreshes only when an unknown `kid` arrives _and_ that window has expired; we do not
   override it. This shared cache adds up to another 300 seconds when the refresh lands on a cached
   entry, so the worst-case window for a new key to become usable in a colo is roughly 900 seconds.
   Emergency rotation therefore purges the JWKS URL from Cloudflare's cache **and** waits out
   jose's 600-second window (or redeploys the reading Worker, which discards every isolate's
   in-process key set). The purge alone reaches only isolates that are about to refetch.

5. **An unknown `kid` never bypasses the shared cache.** A bypass would let an attacker turn
   garbage `kid` values into an uncached-fetch amplifier against the Auth API. The bounded rotation
   window is the accepted trade.

6. **Caching changes only public-key retrieval, and only for how long a _withdrawn_ key stays
   trusted.** A JWKS is public by definition. RS256 signature verification and the existing `aud`
   and `exp` assertions remain unchanged. A missing or failed cache entry never degrades
   verification into a pass: a non-2xx is uncached and reaches jose, which throws. A _stale_ entry
   does have one real consequence, and it is the reason decision 4 states the window in seconds.
   `ACCESS_TOKEN_SECRET` carries a single key, so rotation is a replace and the old `kid`
   disappears; until every cache layer turns over, a token signed by the withdrawn key still
   verifies. That is a bounded revocation delay, not a bypass, and it is what the emergency
   procedure in decision 4 exists to cut short.

7. **The Auth API advertises the same cache window.** Successful JWKS responses carry
   `Cache-Control: public, max-age=300`, which lets every compliant consumer cache the public key
   set on the same contract.

## Consequences

- Bursty control-plane authentication normally performs one Auth API JWKS fetch per colo per five
  minutes instead of one fetch per fresh isolate.
- A routine signing-key rotation can take up to fifteen minutes to become usable in a colo: jose's
  600-second in-process window plus this cache's 300-second TTL.
- Emergency revocation of a compromised key is a two-step runbook: purge the Auth API JWKS URL from
  Cloudflare's cache, then redeploy the reading Workers to drop jose's in-process key sets. Purging
  alone leaves warm isolates trusting the withdrawn key for up to 600 seconds.
- Tenant-JWKS callers retain their current uncached custom transport and resolver isolation.

## Sources

- [Cloudflare Cache: Interaction with Cloudflare products](https://developers.cloudflare.com/cache/interaction-cloudflare-products/workers/)
- [Cloudflare Workers: Cache using fetch](https://developers.cloudflare.com/workers/examples/cache-using-fetch/)
- [ADR-0036](./0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
