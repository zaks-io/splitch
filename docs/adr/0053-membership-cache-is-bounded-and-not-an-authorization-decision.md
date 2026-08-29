# Membership cache is bounded and not an authorization decision

**Status:** accepted

Bearer tokens carry Organization and App roles minted from membership. Resolving the complete
membership set from D1 on every request made authentication a repeated multi-query read. Workers KV
is appropriate for this read-heavy set, but it is eventually consistent: a delete in one location
can take at least the edge cache window to become visible elsewhere. A delete before a D1 mutation
also races with a concurrent miss that can refill the old D1 value before the mutation commits.

The Control Plane stores the complete set under `memberships:{user_id}` with an expiration TTL of
60 seconds. Sixty seconds is deliberate: it is the shortest Workers KV expiration TTL and does not
extend the platform's default roughly one-minute remote visibility window. A cache miss loads the
complete set from D1. Only `GET` and `HEAD` requests fill the cache, so a membership mutation cannot
spend a fill and an invalidation against the same key in one request.

Every membership mutation deletes each affected key before the D1 write and again after the write
commits. The first delete keeps a KV limit fault ahead of the irreversible D1 boundary. The second
delete removes a stale value refilled between the first delete and the commit. Both deletes fail
loud. The only omitted invalidations are operations that cannot change membership cache state: a
freshly minted User during anonymous registration and an App-owner provisioning retry that finds
the membership already present.

The cache resolves token scope but never makes the final tenant-data authorization decision. Every
Control Plane `GET` route containing a canonical `:appId` path axis performs an uncached D1 App
membership read before its handler returns data. The hand-mounted App live-update route performs the
same check. Organization-scoped handlers perform their existing uncached D1 Organization membership
reads, and `GET /orgs` reads D1 directly. Mutating handlers continue to perform their role-specific
uncached D1 checks. A removed member is therefore refused on the next request even if the resolver
reads a stale KV value.

Missing SESSION_STORE bindings and missing mutation invalidators are construction or wiring faults.
They fail loud rather than silently degrading to uncached D1 or allowing a mutation without cache
invalidation. Corrupt or unreadable cache values are logged and rebuilt from D1 because D1 remains
the authoritative membership store.

## Consequences

- KV hits remove the repeated complete-set D1 resolve from bearer authentication.
- App-scoped reads retain one live D1 membership query as the tenant-data backstop.
- Membership writers spend two KV deletes per affected User. Workers KV permits one write per
  second to the same key, so concurrent membership mutations for one User remain a visible fault.
- The TTL is a security bound and is asserted on the actual `KVNamespace.put` call.

## Sources

- [Cloudflare Workers KV write API](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)
- [Cloudflare Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [ADR-0018: Identity in D1, hot validation in KV](./0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0022: One principal across three auth doors](./0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [ADR-0034: Edge abuse controls](./0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md)
