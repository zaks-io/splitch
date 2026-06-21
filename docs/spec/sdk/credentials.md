# SDK credential model: Client Key vs API Key

Which credential the SDK uses, what each can do, how each is stored and validated.

## Two-credential model

An App issues exactly two kinds of SDK credential, **per Environment** (ADR-0027): a prod key reaches
prod config only, a dev key reaches dev config only; keys never span Environments. The choice between
the two kinds is determined by the runtime context — trusted server vs untrusted client.

| Property | API Key (Secret) | Client Key (Public) |
|----------|-----------------|---------------------|
| Secrecy | Secret — never shipped client-side | Public by design — safe in browser / mobile |
| Runtime | Server-side trusted environment | Client-side (browser, mobile, any untrusted runtime) |
| Capability | Full data-plane access | Evaluate flags for its App only |
| Can read config/rules/salt | Yes | No |
| Can write / mint keys | No (SDK-only; control plane manages) | No |
| Cross-App access | No (scoped to issuing App) | No |
| Edge binding | Per-key rate limiting | Origin/referrer allow-list + per-key rate limiting |

## Storage and validation

Both credential types follow the same D1/KV pattern (ADR-0018):

**D1 record shape** (system of record, not on hot path):
```
CredentialRecord {
  id:         string        -- UUID, primary key
  app_id:     string        -- owning App (required, every query scoped here)
  environment_id: string    -- owning Environment (required; the key reaches only this Environment, ADR-0027)
  type:       'api_key' | 'client_key'
  key_hash:   string        -- SHA-256 of the raw credential value; raw value never stored
  scopes:     string[]      -- for API Key: e.g. ['evaluate', 'track']; Client Key: ['evaluate']
  revoked:    boolean
  created_at: timestamp
  revoked_at: timestamp | null
}
```

**KV hot-validation cache** (per-request hot path):
```
KV key:   sha256(rawCredentialValue)
KV value: { app_id, environment_id, type, scopes, revoked }   -- Zod-parsed on every read (ADR-0025)
TTL:      synced from D1 on write/revoke; no fixed TTL
```
Every SDK call validates the presented credential against KV before proceeding. The
`environment_id` in the cache value is how the edge resolves which Environment's config to serve
from the key (ADR-0027). A revoked key propagates to KV immediately on revoke (write-through), so
revocation is effective at the next request.

## Lifecycle

**Client Key lifecycle:**
1. Control plane creates record in D1, writes KV entry.
2. Agent/CLI freely retrieves and shares the Client Key value (it is public).
3. Consumer embeds it in shipped client code.
4. To revoke: control plane sets `revoked = true` in D1 and updates KV; next request fails.

**API Key lifecycle:**
1. Control plane creates record in D1, writes KV entry.
2. Raw value surfaced **once** at creation — agent does not re-read or paste it after (ADR-0022 secret discipline).
3. Developer stores it in their secret manager.
4. To revoke: same D1 + KV path; effective immediately.

## Seam: Client Key edge binding

Client Key requests additionally pass through Cloudflare WAF before reaching the Worker:
- **Origin/referrer allow-list**: configured per Client Key on the WAF; requests from
  unlisted origins are rejected at the edge, never reaching the SDK Worker.
- **Per-key rate limiting**: WAF-enforced; SDK code has no awareness of WAF rejections.
- Failure mode: WAF rejection returns an HTTP 403/429 before the Worker is invoked.
  SDK documentation must state this — a Client Key failure may be a WAF error, not a
  Worker-level error.

No Client Key configuration is required for keys to be valid (allow-list defaults to
permissive). Abuse surface is bounded by rate limiting regardless.

## Seam boundary

- **Port:** `validateCredential(rawValue) -> { app_id, environment_id, type, scopes } | Error`
- **Left side (caller):** the evaluate Worker, which presents the credential from the
  request header (`Authorization: Bearer <value>`)
- **Right side (adapter):** KV lookup + Zod parse; falls through to D1 only on KV miss
- **Failure contract:** invalid or revoked credential → `401 Unauthorized` with
  `ErrorResponse { code: 'INVALID_CREDENTIAL', message }` (ADR-0025 error shape)
- **Deletion test:** passes — API Key and Client Key are two real adapters on this
  same validation port, distinguished by `type`

## Sources

- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [ADR-0022](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [CONTEXT.md — Credential terms](../../../CONTEXT.md)
