# Control-plane Flag Configuration reads accept Workers KV propagation lag

**Status:** accepted

`flag_config_get` used to read D1 through the Config Store Durable Object. SPL-526 moves the warm
read to Workers KV so an ordinary read performs zero D1 prepares and zero Durable Object
subrequests. Workers KV is eventually consistent. Its cache is per location, caches negative
lookups, and may continue serving an older value after a write. This applies to any isolate that is
not carrying the writer's in-memory value, including another isolate in the same colo.

## Decision

1. **The warm read accepts Workers KV consistency.** The read does not add a Durable Object or D1
   validation hop. `cacheTtl` is omitted, so Workers KV uses its 60-second default. Propagation can
   take longer. Supplying an option cannot make the cache immediate because Workers KV enforces a
   minimum TTL.

2. **Read-your-writes is isolate-local.** A successful write stores its revisioned result in an
   in-memory map. A later read in that isolate prefers it until KV returns an
   equal or newer revision. A fresh isolate has no such protection.

3. **The product exposure is explicit per surface.** During the KV window:

   - `flags update` returns the committed Flag Configuration and is safe.
   - `flags update` followed by `flags get` can return the previous Flag Configuration from a
     non-writing isolate.
   - the Control Panel's `config.changed` refetch can return the previous version and remain there
     because the version short-circuit does not issue a second nudge.
   - the verification read after a Promotion can return the previous Flag Configuration.
   - `flags list` after delete is safe because it reads D1.
   - `flags get` after delete can return the pre-delete Flag Configuration until the tombstone
     reaches that KV cache.

   Therefore `flags list` and `flags get` can disagree during the propagation window.

4. **Scope and shape failures are not consistency events.** Every snapshot carries internal App,
   Environment, and Flag identity. A malformed or mis-scoped snapshot is rejected and emits a
   distinct operator event. It is never repaired through D1 as a silent fallback (ADR-0036).

5. **Miss repair is serialized with publication.** D1 capture, revision allocation, all KV writes,
   and broadcast execute in one Config Store mutation queue operation. The repair result is retained
   in the calling isolate while its KV write propagates.

## Consequences

- The latency and infrastructure-cost win is deliberate, but the consistency contract is weaker
  than D1-backed reads.
- Operator and automation flows that require immediate cross-isolate confirmation must use the
  mutation response as their committed result. A later `flags get` is not stronger proof.
- A stronger read contract requires a different storage or coordination design. It must not be
  simulated by an occasional D1 fallback that makes stale reads appear authoritative.

## Sources

- [Cloudflare Workers KV: How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Cloudflare Workers KV: Read key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)
- [ADR-0018](./0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0036](./0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
