# SDK Credentials: Client Key and API Key shapes, lifecycle, KV validation

Pins the two SDK credential types, D1 record shapes, KV hot-validation cache, and capability matrix.
See [access-control-matrix.md](access-control-matrix.md) for the control-plane bearer token (a third,
separate credential used for management operations, never for data-plane evaluation).

## Two credential types

Both keys are **scoped to one Environment** (ADR-0027): `(app_id, environment_id)`. A prod key reaches
prod config only.

| property       | Client Key (public)                             | API Key (secret)                                                    |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| who holds it   | Client-side SDK (browser, mobile)               | Server-side SDK (trusted runtime)                                   |
| secrecy        | Public — ships in client code                   | Secret — never shipped client-side                                  |
| capability     | Evaluate + write-only Metric/Web Event ingest   | Full data-plane access, App+Environment-scoped                      |
| agent behavior | Freely retrieved and surfaced by CLI/MCP        | Provisioned once, value surfaces at creation only; never read after |
| abuse bound    | Origin/referrer allow-list + rate-limit at edge | Secret; never exposed after creation                                |
| KV cache key   | `ck:{key_material_hash}`                        | `ak:{key_hash}`                                                     |

## D1: `client_keys` table

| column             | type    | required | meaning                                                                                                                                                                                         |
| ------------------ | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key_id`           | TEXT PK | yes      | Splitch-generated (`ck_<ulid>`)                                                                                                                                                                 |
| `app_id`           | TEXT FK | yes      | Owning App                                                                                                                                                                                      |
| `environment_id`   | TEXT FK | yes      | Owning Environment — the key reaches only this Environment (ADR-0027)                                                                                                                           |
| `key_material`     | TEXT    | yes      | The public key value shipped to the client (not a hash; this is the public value)                                                                                                               |
| `origin_allowlist` | TEXT    | no       | JSON array of allowed origins/referrers; null = **open to all origins** (see default note below — null is no longer the silent creation default)                                                |
| `rate_limit_rps`   | INTEGER | no       | Per-key override. New writes must be an exact enforceable rps (`1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 25, 30, 50, 60, 75, 100`) or null (ADR 100 rps default). Legacy numeric rows may still exist. |
| `revoked_at`       | TEXT    | no       | ISO 8601; null = active                                                                                                                                                                         |
| `created_at`       | TEXT    | yes      | ISO 8601                                                                                                                                                                                        |

**Auto-provisioned, open-but-loudly-flagged (ADR-0034 §1).** Exactly one
Client Key is auto-created when an Environment is created (see
[endpoints-credentials.md](endpoints-credentials.md#auto-provisioning)), so a key always exists and
`GET …/client-key` never 404s. To keep onboarding friction-free, the auto-provisioned key starts
`origin_allowlist = null` — **open to all origins** and immediately usable with zero config (industry
norm for public client-side keys).

The security obligation is met not by a create-time gate but by a **loud, always-visible open-state
warning** plus a one-action "lock to origins" affordance:

- The control panel shows a persistent banner on any open (`origin_allowlist = null`) Client Key
  ("This key accepts requests from any origin — lock it to your domains").
- The CLI/MCP `client_key_get` response carries an `is_origin_open: true` flag and a warning line.
- The per-key rate limit (default 100 rps) is the volume backstop while a key is open.

`origin_allowlist = null` = open to all origins; `origin_allowlist = []` = closed, serves nothing;
a non-empty array = closed to all but the listed origins. Locking down is a single `PATCH …/client-key`
with the origin list. Origin/referrer is a first-class Cloudflare match characteristic, so an open key
is leaving the strongest edge control unused — the UI must never let that state be silent, only
friction-free to start and one click to fix.

## D1: `api_keys` table

| column            | type    | required | meaning                                                               |
| ----------------- | ------- | -------- | --------------------------------------------------------------------- |
| `key_id`          | TEXT PK | yes      | Splitch-generated (`ak_<ulid>`)                                       |
| `app_id`          | TEXT FK | yes      | Owning App                                                            |
| `environment_id`  | TEXT FK | yes      | Owning Environment — the key reaches only this Environment (ADR-0027) |
| `key_hash`        | TEXT    | yes      | bcrypt or SHA-256 hash of the secret; the secret is never stored      |
| `scopes`          | TEXT    | yes      | JSON array; see scope format below                                    |
| `revoked_at`      | TEXT    | no       | ISO 8601; null = active                                               |
| `last_rotated_at` | TEXT    | no       | ISO 8601; set on each rotation                                        |
| `created_at`      | TEXT    | yes      | ISO 8601                                                              |

**API Key secret discipline:** The raw key value is surfaced exactly once at creation (in the create-key
response), then the value is gone. The control plane stores only the hash. An agent calling "get API key"
receives `key_id`, `scopes`, and lifecycle fields — never `key_hash` and never the original secret.

## Scope format

Control-plane token scopes: `app:{app_id}:{role}` where role is `owner`, `admin`,
or `member`.

API Key scopes for data-plane: `["data-plane:evaluate", "data-plane:write"]`. All API Keys have
both. Granular scopes are future work.

## KV hot-validation cache

Every SDK call presents either a Client Key or an API Key. The Worker validates via KV before touching D1.

**Client Key cache entry:**

```
Key:   ck:{sha256(key_material)}
Value: { organizationId, app_id, environment_id, capabilities: ["evaluate", "track"], revoked: boolean, origin_allowlist: string[] | null, valid_until: ISO8601 }
```

The existing `track` capability authorizes both strict route-specific write surfaces:
`POST /api/sdk/events` for Metric Events and `POST /api/sdk/web-events` for Web Events. It is not a
generic event, configuration, or analytics-read capability.

**API Key cache entry:**

```
Key:   ak:{key_hash}
Value: { app_id, environment_id, scopes: string[], revoked: boolean, valid_until: ISO8601 }
```

**Terminal revocation marker:**

```
Key:   revoked:{credential_cache_key}
Value: presence marker
```

The data plane checks this permanent marker before the mutable credential entry. Backfill and other
active writers never delete it, so an in-flight stale write cannot make a revoked credential active.

### Credential cache schema-v1 rollout

Credential cache payload version 2 adds the owning `organizationId`. This value is authoritative D1
App ownership, not request input. During rollout, the Evaluation Worker can parse a schema-v1 entry
but treats it as unscoped and returns `503 SERVICE_UNAVAILABLE` for the billing-bearing `evaluate`
route. It never guesses an Organization or writes usage without one.

The control-plane daily scheduled job is the steady-state backfill path. During a hosted rollout, the
deployment workflow first deploys the marker-aware Evaluation Worker, which remains compatible with
marker-less schema-v1 entries. It then deploys the Control Plane compatibility writer, drives its protected,
versioned backfill gate to `done`, and verifies that checkpoint before the final Control Plane cutover. A
legacy `done` checkpoint cannot satisfy a newer migration.
This is CI-owned automation, never a manual production deploy. The backfill joins every D1 Client Key
and API Key to `apps.organization_id` and rewrites its KV entry as schema v2. The write is fail-loud
and idempotent, so the next scheduled run retries an incomplete migration. Once the v2 entry exists,
the data plane supplies that authenticated Organization scope to Evaluation usage ingest.

The `environment_id` in the cache value is how the edge resolves an evaluation to the correct
Environment's Flag Configuration — the key carries its Environment, so the caller never specifies it.

**Write-through contract:**

- On D1 create: write KV entry immediately. Until the data plane implements the D1 fallback
  below, active entries are written **without an expiry** — the data plane rejects a KV miss as
  UNAUTHORIZED, so an expiring active entry would brick a deployed SDK key one TTL after the
  last control-plane touch. Revocation correctness comes from the explicit tombstone, never
  from active-entry expiry.
- On D1 revoke: write the permanent terminal marker, then a **revoked tombstone** KV entry
  (`revoked: true`) with a short TTL, and **fail loud** if either write-through errors (see revoke
  contract below) — revoke is never best-effort
- KV miss on hot path (future, requires a data-plane path to D1): fall back to D1 lookup. If D1
  marks the key revoked, **re-assert the revoked tombstone** in KV rather than treating the miss
  as "unknown / re-validate as valid", then reject

**Failure contract (create):** If KV write-through fails on create, the D1 row is the system of record.
The next request sees a KV miss, falls back to D1, and re-populates KV. No distributed transaction.

**Revoke contract (fail-loud, ADR-0034):** Revocation is the one credential operation that is **not**
fire-and-forget — a leaked secret API Key is exactly the incident the threat model exists for.

- The revoke KV write-through is **surfaced and retried on failure**, never silently accepted. A failed
  revoke propagation is an operational alarm, not an accepted window.
- The revoked key id is **negative-cached** by a permanent terminal marker plus the short-lived
  tombstone at the mutable entry. A stale active writer can replace the mutable entry, but cannot remove
  the marker that the data plane checks first.
- The schema-v1 rollout backfill writes terminal markers for credentials already revoked in D1. Until
  the version 2 backfill reaches `done`, operators must assume a pre-rollout revoked credential may still
  have an active legacy cache entry. After version 2 reaches `done`, the marker is the durable revocation
  authority. The deployment order never runs this backfill while a marker-blind Evaluation Worker is live.
  Rolling Evaluation back to a marker-blind version requires reasserting revoked primary entries first.
- The kill-switch / incident posture wins (CONTEXT.md): revoke must propagate as fast as the edge allows
  and must report when it does not.

## Edge abuse controls (Client Key) — Cloudflare-enforced (ADR-0034)

The target controls below are Cloudflare-native (WAF rate limiting, origin/referrer match, Turnstile).
They are layered, not either/or: rate limiting bounds volume, origin/referrer bounds reach, Turnstile
bounds bots. The current Cloudflare Free launch posture is narrower: Turnstile and the in-app controls
remain required, while the live source-IP rule on exact path `/agent/identity` is only a short-window
partial control. ADR-0034 records the verified rule and the paid WAF controls deferred until traffic
justifies the plan cost.

- **Per-Client-Key rate limit:** 100 rps default. `PATCH` accepts only the exact integers the
  Cloudflare 3000-token / 10s binding can enforce (`1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 25, 30, 50,
60, 75, 100`). A legacy or corrupt cached number is parsed on the Evaluation read path and fail-closes
  as typed `RATE_LIMITED`, not `500`. The counter is keyed on the Client Key hash plus route class, so
  one key's abuse cannot spend another's budget.
- **Origin/referrer check:** if `origin_allowlist` is non-null, requests must match. Auto-provisioned
  keys start open (`null`, loudly flagged — see the open-state note above); locking down is a one-step
  `PATCH …/client-key`.
  **An origin-blocked request fails loud, not generic (DX).** When a valid Client Key is rejected only
  because the request origin is not on its allow-list, the response is a distinct, self-explaining
  `403 ORIGIN_NOT_ALLOWED` carrying the offending origin in `details` (`{ origin, hint:
"add this origin to the Client Key allow-list or open the key" }`) — not an undistinguished WAF 403.
  This closes the "origin-closed key silently fails until deploy" trap: the developer sees exactly why
  and how to fix it. The detail is safe to reveal (the caller already knows its own origin); it leaks
  no config, rules, or allocation. Where the WAF blocks before the Worker, the WAF response uses the
  same `ORIGIN_NOT_ALLOWED` code so both layers read identically (ADR-0036 fail-loud spirit).
- **Public evaluate surface:** the per-key counter is current; progressive WAF rate-limit rules
  (challenge before block) are part of the deferred full WAF posture.
- **Anonymous registration endpoint:** Cloudflare **Turnstile** (challenge before any row is created,
  verified server-side via siteverify, single-use, 300s token), the in-app per-IP/global limiter, and the
  current partial source-IP WAF rule. The authoritative one-hour cross-IP/global WAF ceiling remains
  deferred; per-IP alone is defeated by IP rotation (see [auth-doors.md](auth-doors.md)).
- **Peek is not a Client Key surface (ADR-0034):** `peekVariant` requires an API Key, not a Client Key —
  see [../sdk/exposure-accessor.md](../sdk/exposure-accessor.md). The Client Key's evaluation capability
  is Exposure-bearing `evaluate`.
- **Verify is a Client Key surface (ADR-0037):** the non-exposing setup-confirmation path `/verify` IS
  available under a Client Key, because it reveals nothing beyond what `evaluate` already returns (the
  Variant value + a non-revealing `reason`) and never names the matched rule (ADR-0018). It is
  rate-limited and origin-bound exactly like `evaluate`, so it is not an allocation oracle (unlike a
  silent peek). Under an API Key, `/verify` returns the full resolution reason. See
  [../sdk/exposure-accessor.md](../sdk/exposure-accessor.md) and ADR-0037.
- **Event ingest is a narrow Client Key surface:** `POST /api/sdk/events` accepts only strict Metric
  Event writes and `POST /api/sdk/web-events` accepts only strict Web Event writes. Both inject App
  and Environment from the credential, reveal no Event Definition, configuration, or analytics
  data, and apply the same origin and rate-limit controls as evaluate. See
  [../pipeline/metric-event-contract.md](../pipeline/metric-event-contract.md) and
  [../sdk/web-analytics-capture.md](../sdk/web-analytics-capture.md).
- Target mechanism throughout: Cloudflare WAF / rate-limiting rules / Turnstile (ADR-0017,
  all-Cloudflare). ADR-0034 distinguishes the partial Free-plan launch control from that full contract.

## Sources

- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md](../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md)
- [../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [../../adr/0037-client-side-configuration-verification-tiered-by-credential.md](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md)
