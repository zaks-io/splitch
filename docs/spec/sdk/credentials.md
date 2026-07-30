# SDK credential model: Client Key vs API Key

Which credential the SDK uses, what each can do, how each is stored and validated.

## Two-credential model

An App issues exactly two kinds of SDK credential, **per Environment** (ADR-0027): a prod key reaches
prod config only, a dev key reaches dev config only; keys never span Environments. The choice between
the two kinds is determined by the runtime context — trusted server vs untrusted client.

| Property                   | API Key (Secret)                     | Client Key (Public)                                  |
| -------------------------- | ------------------------------------ | ---------------------------------------------------- |
| Secrecy                    | Secret — never shipped client-side   | Public by design — safe in browser / mobile          |
| Runtime                    | Server-side trusted environment      | Client-side (browser, mobile, any untrusted runtime) |
| Capability                 | Full data-plane access               | Evaluate plus strict write-only Metric/Web ingest    |
| Can read config/rules/salt | Yes                                  | No                                                   |
| Can write / mint keys      | No (SDK-only; control plane manages) | No                                                   |
| Cross-App access           | No (scoped to issuing App)           | No                                                   |
| Edge binding               | Per-key rate limiting                | Origin/referrer allow-list + per-key rate limiting   |

## Which key goes where (first-run placement)

The single most common first-run mistake is pasting the wrong key. The rule: **Client Key in code
that ships to users; API Key only in a trusted server you control.**

| You are…                                         | Use            | Get it with                                   | Goes in                          |
| ------------------------------------------------ | -------------- | --------------------------------------------- | -------------------------------- |
| Browser / mobile / any client a user can inspect | **Client Key** | `splitch client-key get` / `client_key_get`   | App config — safe to commit/ship |
| Backend, edge function, trusted server runtime   | **API Key**    | `splitch api-keys create` / `api_keys_create` | A secret manager — never shipped |

```ts
// Browser / mobile — Client Key (public, safe to ship):
const splitch = createSplitchClient({ clientKey: "ck_live_..." });

// Backend / trusted server — API Key (secret; from your secret manager):
const splitch = createSplitchClient({ apiKey: process.env.SPLITCH_API_KEY });
```

If you paste an API Key into client code it is now leaked — rotate it. If you paste a Client Key into
a server, evaluation still works (Client Keys hold `evaluate`), you just don't get the API-Key tier
(peek, full `verify` reason). The keys are not interchangeable for capability; pick by runtime trust.

The Client Key also authorizes only the strict write-only `track()` and `web.track()` routes. It
cannot read Event Definitions, event rows, Web Analytics, or configuration, and both writes remain
origin-bound and rate-limited.

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
  scopes:     string[]      -- API Key scopes; Client Key capabilities are structural
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

Client Keys are **auto-provisioned open to all origins** (`origin_allowlist = null`) so the public SDK
works with zero setup; the open state is never silent — it is loudly surfaced (`is_origin_open` flag +
control-panel banner) and one `PATCH …/client-key` from locked (ADR-0034; see
[../control-plane/credentials-and-keys.md](../control-plane/credentials-and-keys.md)). Lock to your app's
origins before shipping to production. Abuse surface is bounded by rate limiting regardless.

## Seam boundary

- **Port:** `validateCredential(rawValue) -> { app_id, environment_id, type, scopes } | Error`
- **Left side (caller):** the evaluate Worker, which presents the credential from the
  request header (`Authorization: Bearer <value>`)
- **Right side (adapter):** KV lookup + Zod parse; falls through to D1 only on KV miss
- **Failure contract:** missing or invalid credential → `401` with
  `ErrorResponse { code: 'UNAUTHORIZED' }`; revoked credential → `403` with
  `ErrorResponse { code: 'CREDENTIAL_REVOKED' }` (canonical codes, ADR-0025 error shape —
  see [../contracts/error-responses.md](../contracts/error-responses.md))
- **Deletion test:** passes — API Key and Client Key are two real adapters on this
  same validation port, distinguished by `type`

## Sources

- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [ADR-0022](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [CONTEXT.md — Credential terms](../../../CONTEXT.md)
