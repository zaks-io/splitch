# SDK Credentials: Client Key and API Key shapes, lifecycle, KV validation

Pins the two SDK credential types, D1 record shapes, KV hot-validation cache, and capability matrix.
See [access-control-matrix.md](access-control-matrix.md) for the control-plane bearer token (a third,
separate credential used for management operations, never for data-plane evaluation).

## Two credential types

Both keys are **scoped to one Environment** (ADR-0027): `(app_id, environment_id)`. A prod key reaches
prod config only.

| property           | Client Key (public)                              | API Key (secret)                          |
|--------------------|--------------------------------------------------|-------------------------------------------|
| who holds it       | Client-side SDK (browser, mobile)                | Server-side SDK (trusted runtime)         |
| secrecy            | Public — ships in client code                    | Secret — never shipped client-side        |
| capability         | Evaluate-only, App+Environment-scoped            | Full data-plane access, App+Environment-scoped |
| agent behavior     | Freely retrieved and surfaced by CLI/MCP         | Provisioned once, value surfaces at creation only; never read after |
| abuse bound        | Origin/referrer allow-list + rate-limit at edge  | Secret; never exposed after creation      |
| KV cache key       | `ck:{key_material_hash}`                         | `ak:{key_hash}`                           |

## D1: `client_keys` table

| column             | type    | required | meaning                                                               |
|--------------------|---------|----------|-----------------------------------------------------------------------|
| `key_id`           | TEXT PK | yes      | Splitch-generated (`ck_<ulid>`)                                       |
| `app_id`           | TEXT FK | yes      | Owning App                                                            |
| `environment_id`   | TEXT FK | yes      | Owning Environment — the key reaches only this Environment (ADR-0027) |
| `key_material`     | TEXT    | yes      | The public key value shipped to the client (not a hash; this is the public value) |
| `origin_allowlist` | TEXT    | no       | JSON array of allowed origins/referrers; null = allow all (default at creation) |
| `rate_limit_rps`   | INTEGER | no       | Per-key rate limit override; null = global default (100 rps)          |
| `revoked_at`       | TEXT    | no       | ISO 8601; null = active                                               |
| `created_at`       | TEXT    | yes      | ISO 8601                                                              |

**Note on `origin_allowlist = null`:** Null means no origin restriction at creation. The key is immediately
usable. Origins are optional — the edge rate-limit provides the abuse bound when no origin is configured.
This answers the open question: Client Key is immediately usable on creation; no separate activation step.

## D1: `api_keys` table

| column            | type    | required | meaning                                                              |
|-------------------|---------|----------|----------------------------------------------------------------------|
| `key_id`          | TEXT PK | yes      | Splitch-generated (`ak_<ulid>`)                                      |
| `app_id`          | TEXT FK | yes      | Owning App                                                           |
| `environment_id`  | TEXT FK | yes      | Owning Environment — the key reaches only this Environment (ADR-0027) |
| `key_hash`        | TEXT    | yes      | bcrypt or SHA-256 hash of the secret; the secret is never stored     |
| `scopes`          | TEXT    | yes      | JSON array; see scope format below                                   |
| `revoked_at`      | TEXT    | no       | ISO 8601; null = active                                              |
| `last_rotated_at` | TEXT    | no       | ISO 8601; set on each rotation                                       |
| `created_at`      | TEXT    | yes      | ISO 8601                                                             |

**API Key secret discipline:** The raw key value is surfaced exactly once at creation (in the create-key
response), then the value is gone. The control plane stores only the hash. An agent calling "get API key"
receives `key_id`, `scopes`, and lifecycle fields — never `key_hash` and never the original secret.

## Scope format

Control-plane token scopes: `app:{app_id}:{role}` where role is `owner`, `admin`,
or `member`.

API Key scopes for data-plane: `["data-plane:evaluate", "data-plane:write"]`. In v1 all API Keys have
both. Granular scopes are future work.

## KV hot-validation cache

Every SDK call presents either a Client Key or an API Key. The Worker validates via KV before touching D1.

**Client Key cache entry:**
```
Key:   ck:{sha256(key_material)}
Value: { app_id, environment_id, revoked: boolean, origin_allowlist: string[] | null, valid_until: ISO8601 }
```

**API Key cache entry:**
```
Key:   ak:{key_hash}
Value: { app_id, environment_id, scopes: string[], revoked: boolean, valid_until: ISO8601 }
```

The `environment_id` in the cache value is how the edge resolves an evaluation to the correct
Environment's Flag Configuration — the key carries its Environment, so the caller never specifies it.

**Write-through contract:**
- On D1 create: write KV entry immediately with `valid_until = now + 1h` (default TTL)
- On D1 revoke: write KV entry with `revoked: true`, TTL = 5 min (fast propagation on revoke)
- KV miss on hot path: fall back to D1 lookup, then write KV entry

**Failure contract:** If KV write-through fails on create/revoke, the D1 row is the system of record.
The next request sees a KV miss, falls back to D1, and re-populates KV. No distributed transaction.
Revoked keys may pass for up to 5 min (the TTL) if KV write fails; this is accepted (rate-limit window).

## Edge abuse controls (Client Key)

- Per-Client-Key rate limit: 100 rps default, configurable via `client_keys.rate_limit_rps`
- Origin/referrer check: if `origin_allowlist` is non-null, requests must match
- Per-IP rate limit on anon registration endpoint (separate, see [auth-doors.md](auth-doors.md))
- Mechanism: Cloudflare WAF / rate-limiting rules (v1 scope)

## Sources

- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
