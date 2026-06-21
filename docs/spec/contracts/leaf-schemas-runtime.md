# Leaf schemas: EvaluationContext, Exposure, and identity/credential leaves

Canonical field lists for the runtime/identity glossary nouns: EvaluationContext, Exposure event, and
the Organization/App/User/SDKCredential block. Every noun is ONE Zod schema in `@splitch/contracts`;
request, response, and storage shapes compose these leaves and never redefine them.

Any field addition here propagates to every envelope automatically.

---

## EvaluationContext

Carried by every evaluate / test-evaluate request. `targetingKey` is first-class and separate from
attributes.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `targetingKey` | `string` | yes | The Entity identifier; the single stable identifier splitch buckets on |
| `idType` | `string` | yes | Entity type label (e.g. `'user'`, `'workspace'`); included in the Assignment Store key and Exposure row to guard cross-type collisions |
| `attributes` | `Record<string, boolean \| string \| number \| unknown[]>` | yes | Arbitrary key-value bag for Condition matching; may be empty `{}` |

---

## Exposure event

The only event on the Assignment/Exposure seam. Appended to Tinybird. Every field is required so
the wire `dedup_key` is always satisfiable.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `dedupKey` | `string` (sha256) | yes | Wire-level idempotency key; unique per raw Exposure fire; construction in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md) |
| `appId` | `string` | yes | Isolation field; first in Tinybird sort key |
| `experimentId` | `string` | yes | — |
| `runId` | `string` | yes | Stamped at SDK fire-time from the live Run the SDK resolved; not ingest-time |
| `idType` | `string` | yes | Entity type; part of Assignment Store key |
| `targetingKey` | `string` | yes | Entity identifier |
| `variantName` | `string` | yes | The Variant name served (string; Exposure logs name not id) |
| `type` | `'exposure' \| 'activation'` | yes | Discriminator; activations share this schema |
| `counterfactual` | `boolean` | yes | `false` for real Exposures; reserved for future counterfactual triggering |
| `clientTimestamp` | `string` (ISO 8601) | yes | When the SDK fired the event (diagnostic only; subject to clock skew) |
| `serverReceivedAt` | `string` (ISO 8601) | yes | Canonical ingest time; used for `MIN(ts)` first-touch ordering |

First-touch identity: the tuple `(appId, experimentId, runId, idType, targetingKey)` resolved by
`MIN(serverReceivedAt)` — the earliest wins. Distinct from the wire `dedup_key` above.

---

## Organization, App, User, SDK credentials

See [two-packages-topology.md](./two-packages-topology.md) for credential consumer policy.

### Organization
| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | WorkOS Organization ID |
| `name` | `string` | yes | — |
| `plan` | `OrgPlan` | yes | Default `'free'` |
| `createdAt` | `string` (ISO 8601) | yes | — |
| `updatedAt` | `string` (ISO 8601) | yes | — |

`OrgPlan` enum: `'free' | 'pro' | 'enterprise'`

### App
| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | — |
| `organizationId` | `string` | yes | Owning Organization |
| `name` | `string` | yes | — |
| `key` | `string` | yes | Unique per Organization |
| `description` | `string` | no | — |
| `createdAt` | `string` (ISO 8601) | yes | — |
| `updatedAt` | `string` (ISO 8601) | yes | — |

### User
| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | WorkOS User ID |
| `email` | `string` | yes | — |
| `organizationId` | `string` | yes | Membership Organization |
| `role` | `UserRole` | yes | — |
| `createdAt` | `string` (ISO 8601) | yes | — |

`UserRole` enum: `'owner' | 'admin' | 'member'`

### SDKCredential (abstract leaf)
| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable UUID |
| `appId` | `string` | yes | Scoped to one App |
| `kind` | `'api_key' \| 'client_key'` | yes | Discriminator |
| `name` | `string` | yes | Human label |
| `description` | `string` | no | — |
| `hash` | `string` | yes | SHA-256 of raw value; never the raw value |
| `scopes` | `string[]` | yes | Capability set |
| `revoked` | `boolean` | yes | — |
| `createdAt` | `string` (ISO 8601) | yes | — |
| `revokedAt` | `string \| null` (ISO 8601) | no | — |

**APIKey** extends SDKCredential: `kind = 'api_key'`, `scopes = ['read:config', 'write:config', 'expose', 'assign']`. Long-lived (no forced expiry). Surfaced once at creation; never readable after. Agent provisions; never reads existing value.

**ClientKey** extends SDKCredential: `kind = 'client_key'`, `scopes = ['evaluate']`, plus `originAllowlist: string[]` (CORS-style). Freely retrieved by the agent; safe to embed in client code. Created immediately usable; origins default to `[]` (allow-all). Tighten with origin allowlist before production.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
