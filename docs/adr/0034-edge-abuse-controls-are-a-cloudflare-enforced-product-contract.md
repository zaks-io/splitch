# Edge abuse controls are a Cloudflare-enforced product contract

**Status:** accepted

Splitch's code is public, so its security posture cannot rely on obscurity. The public data-plane
surfaces (evaluate, peek, anonymous registration) and the secret-key revocation path are the highest
blast-radius seams. This ADR pins their abuse controls as an **enforced contract** carried by the
Cloudflare edge already chosen in ADR-0017 — Turnstile, WAF rate limiting, and origin/referrer
allow-listing — and tightens four defaults that were previously open or best-effort.

This refines ADR-0018 (which introduced the public Client Key and named origin allow-list + rate
limiting as its abuse bound) and ADR-0022 (which rate-limited anonymous registration per IP only).

## Decision

All four controls below are mandatory, not configurable-to-off, and enforced at the Cloudflare edge.
No second mechanism is invented; these compose with the WAF already in use.

### 1. Public Client Keys are origin-closed by default

A newly minted Client Key is **not** open to all origins. `origin_allowlist = null` (allow-all) is no
longer the creation default. A Client Key is created either with at least one origin, or in a state the
control panel and CLI/MCP surface loudly flag as "open to all origins." The zero-friction path must be
the safe one. Origin/referrer is a first-class Cloudflare rate-limit and match characteristic; leaving
it unset leaves the strongest available edge control unused.

### 2. Peek is a server-side (API Key) path, not a public (Client Key) path

`peekVariant` resolves a Variant **without** firing an Exposure and leaves no SRM trace. Under a public
Client Key that is a silent, untraceable allocation oracle: an attacker sweeps Targeting Keys, reads the
variant each gets, and reconstructs the rollout/allocation without polluting analysis or tripping SRM.
Peek therefore requires an **API Key** (trusted server runtime), not a Client Key. The legitimate peek
use cases (server-side pre-computation, below-the-fold decisions made server-side) are predominantly
server-side already. Client-side below-the-fold deferral is served by firing `evaluate` when the element
scrolls into view, not by a silent client peek. The public Client Key keeps exactly one capability:
`evaluate`, which always leaves an Exposure.

### 3. Credential revocation fails loud and fast

Revocation is the one credential operation that must never be fire-and-forget. On revoke:

- The KV validation cache is written with a short TTL (revoked tombstone), and a write-through failure
  is **surfaced and retried**, never silently accepted. (This corrects the prior "revoked keys may pass
  for up to 5 min, accepted" stance, which violated fail-loud for the one case that matters: a leaked
  secret API Key.)
- The revoked key id is **negative-cached** (an explicit revoked tombstone), so a KV miss for a key D1
  marks revoked re-asserts the tombstone rather than falling back to a stale "valid" read. The exposure
  window shrinks from "always up to one TTL" to "until the next read re-asserts," and never silently
  exceeds it.

### 4. Anonymous registration and the public edge use Turnstile plus WAF rate limiting

Anonymous provisional Org+App creation (ADR-0022, Door B) is a public, unauthenticated **write** surface
that mints WorkOS users and D1 rows. Per-IP rate limiting alone is trivially defeated by IP rotation.
It is therefore gated by **Cloudflare Turnstile** (challenge before any row is created) in addition to a
**global** WAF rate limit, not only the per-IP limit. Turnstile tokens are verified server-side
(siteverify), are single-use, and expire in 300s. The same layered posture — progressive WAF rate-limit
rules (challenge before block) plus per-credential counters keyed on the SDK key — applies to the public
evaluate surface.

## Considered options

- **Keep origin allow-list null-default (open), rely on rate limit alone** — rejected. Rate limiting
  bounds volume but not a low-and-slow allocation oracle, and allow-all-by-default makes the insecure
  configuration the path of least resistance. Cloudflare's own guidance treats origin/referrer as a
  primary control, not an afterthought.
- **Keep peek on the public Client Key, just rate-limit it** — rejected. A silent, SRM-invisible read is
  a better reconnaissance tool than evaluate; sharing a rate budget caps volume but not the oracle's
  existence. Moving peek behind the API Key removes the oracle outright.
- **Per-IP rate limit only on anonymous registration** — rejected. IP rotation defeats it; a public
  write surface that creates identity records needs a bot-challenge (Turnstile) and a global ceiling.
- **Accept the 5-minute revoke propagation window silently** — rejected. It contradicts fail-loud for a
  leaked secret key, the exact incident the threat model exists for.

## Consequences

- The public Client Key's only capability is Exposure-bearing `evaluate`. Peek, reasons, config, rule
  sets, and salt are all off the public path (reasons/config already lived behind the control-plane
  token per ADR-0018/0026; peek now joins the server-side surface).
- New Client Keys require an origin decision (or an explicit, loud "open" acknowledgement) at creation.
  This is a posture change that is cheap now and painful after keys exist in the wild.
- Revocation gains a fail-loud write contract and a negative cache; the KV write-through for revoke is
  no longer best-effort.
- Anonymous registration depends on Turnstile being configured; the control is a launch blocker for that
  surface, consistent with treating these as an enforced contract.
- Origin/referrer allow-list, per-credential rate-limit counters, global rate limits, and Turnstile are
  all Cloudflare-native — no new platform, consistent with ADR-0017.

## Sources

- [ADR-0017: all-Cloudflare stack](./0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [ADR-0018: identity and operational state in D1; hot validation in KV; audit log in Tinybird](./0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0022: agent and human auth, one principal three doors](./0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [ADR-0026: test-evaluation endpoint dry-run never exposes](./0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [ADR-0032: privacy/data lifecycle is an enforced product contract](./0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)
- [Cloudflare WAF rate limiting best practices](https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/)
- [Cloudflare Turnstile overview](https://developers.cloudflare.com/turnstile/)
- [Integrating Turnstile with the Cloudflare WAF](https://blog.cloudflare.com/integrating-turnstile-with-the-cloudflare-waf-to-challenge-fetch-requests/)
