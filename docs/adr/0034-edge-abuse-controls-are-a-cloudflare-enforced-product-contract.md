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

### 1. Public Client Keys are open by default, secured by loud open-state surfacing

One Client Key is **auto-provisioned when an Environment is created** so the public SDK works with zero
setup; it starts `origin_allowlist = null` (open to all origins). The zero-friction path is the default
because a public client-side key that needs configuration before the first `evaluate` is friction the
industry norm has already rejected, and because the key carries exactly one capability — Exposure-bearing
`evaluate` — never a silent oracle (see §2).

The security obligation is met not by a create-time gate but by making the open state **impossible to
miss and trivial to fix**: every surface flags an open key loudly (control-panel banner, an
`is_origin_open` field on the CLI/MCP `client_key_get` response) and offers a one-action "lock to origins"
(`PATCH …/client-key` with the origin list). `origin_allowlist = null` = open; `[]` = closed, serves
nothing; a non-empty array = closed to all but the listed origins. Origin/referrer is a first-class
Cloudflare match characteristic, so an open key leaves the strongest edge control unused — the contract
is that this state is always visible and one click from closed, never that it is forbidden at creation.
The per-key rate limit (default 100 rps) is the volume backstop while a key is open.

### 2. Peek is a server-side (API Key) path, not a public (Client Key) path

`peekVariant` resolves a Variant **without** firing an Exposure and leaves no SRM trace. Under a public
Client Key that is a silent, untraceable allocation oracle: an attacker sweeps Targeting Keys, reads the
variant each gets, and reconstructs the rollout/allocation without polluting analysis or tripping SRM.
Peek therefore requires an **API Key** (trusted server runtime), not a Client Key. The legitimate peek
use cases (server-side pre-computation, below-the-fold decisions made server-side) are predominantly
server-side already. Client-side below-the-fold deferral is served by firing `evaluate` when the element
scrolls into view, not by a silent client peek. The public Client Key keeps exactly one capability:
`evaluate`, whose successful fresh assignment under a live Experiment Run always leaves an Exposure.
Disabled, no-Experiment, no-live-Run, holdover, and error branches reveal no live allocation and leave
no new Exposure.

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

- **Origin-closed at creation (require an origin or an explicit "open" acknowledgement before the key
  works)** — rejected. It puts configuration friction in front of the first `evaluate`, the exact step
  onboarding must keep frictionless, and it is out of step with how public client-side keys work
  elsewhere. The oracle concern that would otherwise justify a closed default is removed at the source by
  §2 (peek is API-Key-only), so the open Client Key carries only Exposure-bearing `evaluate`. Rate
  limiting bounds volume, and the loud open-state surfacing (banner + `is_origin_open` + one-click lock)
  keeps the insecure configuration visible and cheap to fix rather than silent. Cloudflare's guidance
  still treats origin/referrer as a primary control — which is why locking down is one action, not a
  buried setting.
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
- A Client Key is auto-provisioned per Environment and usable immediately (open), so onboarding needs no
  credential step. The trade is that an open key can exist unattended; the open-state surfacing
  (banner + `is_origin_open` + one-click lock) is therefore part of the contract, not optional polish —
  shipping the open default without the loud surfacing would reintroduce the silent-insecure-config
  failure this ADR exists to prevent.
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
