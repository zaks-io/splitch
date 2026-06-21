# Storage schemas: KV namespaces and the Assignment Store

KV value schemas (Zod-parsed on every read) plus the Assignment Store's per-Entity KV read model.

Storage shapes carry internals (timestamps, dedup keys, immutability markers) that wire shapes
must not expose. Every Zod-parsed surface is listed here. (ADR-0025 "reuse at the leaf, not the envelope".)

---

## KV namespaces (Zod-parsed on every read)

Every KV value is a JSON blob Zod-parsed on read. A malformed blob fails loud with
`INTERNAL_SERVER_ERROR` — never a partial valid object flowing into evaluation.
(ADR-0025 "every KV read is Zod-parsed, including hot-path reads".)

| Namespace key pattern | Value schema | TTL | Notes |
|---|---|---|---|
| `app:{appId}:flag:{flagKey}` | `FlagConfigKV` | none (invalidated on change) | Hot-path flag config read |
| `app:{appId}:run:{runId}` | `RunConfigKV` | none | Hot-path live Run read |
| `cred:{hash}` | `CredentialCacheKV` | 60s | Credential validation cache; evicted on revoke |
| `app:{appId}:liveRun` | `{ runId: string }` | none | Written on Publish; edge reads this to know the live Run |

### FlagConfigKV

```
{
  id:               string
  key:              string
  enabled:          boolean
  defaultVariantId: string
  variants:         Variant[]
  targetingRules:   TargetingRule[]
  updatedAt:        string  // ISO 8601; cache-bust signal
}
```

### RunConfigKV

```
{
  id:                  string
  experimentId:        string
  salt:                string
  allocation:          Record<string, number>  // variantId -> percentage
  variantSet:          Variant[]
  targetingSegmentId:  string | null
  configHash:          string
  startedAt:           string  // ISO 8601
}
```

Note: `targetingKey` is NOT in RunConfigKV — it lives on Experiment and is fetched from D1 on the
control plane. Edge evaluate path reads it from `ExperimentConfigKV` (see below).

### ExperimentConfigKV (added to support edge evaluate)

```
{
  id:           string
  flagId:       string
  targetingKey: string
  liveRunId:    string | null
}
```

### CredentialCacheKV

```
{
  appId:    string
  kind:     'api_key' | 'client_key'
  scopes:   string[]
  revoked:  boolean
  cachedAt: string  // ISO 8601
}
```

---

## Assignment Store (KV + Durable Object, per ADR-0009)

Not a D1 table. The per-key Durable Object is the serialized writer; KV is the read replica.

KV key pattern: `assignment:{appId}:{idType}:{targetingKey}` — per-Entity, NO `experimentId`. One read
returns all experiments' holdovers for the Entity.

KV value (Zod-parsed on every read):

```
AssignmentStoreValue = Map<experimentId, {
  runId:   string
  variant: string  // Variant name
}>
```

The per-key Durable Object writer is keyed per `(appId, experimentId, idType, targetingKey)` and merges
its record into the Entity-keyed KV map under its `experimentId`. Read granularity (per-Entity) and write
granularity (per-Experiment) differ by design (ADR-0008/0009).

Written at first-touch Exposure (NOT at assignment time). `runId` is stamped from the live Run at
fire-time, so holdovers keep their original Run attribution across Run boundaries.

The Durable Object id is derived from the per-Experiment writer key. Its `putIfAbsent` is atomic (one
winner for concurrent POPs). KV miss on a subsequent read is self-healing — `assign()` is deterministic
and recomputes the same Variant.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0009-assignment-store-substrate-kv-read-do-write.md](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
